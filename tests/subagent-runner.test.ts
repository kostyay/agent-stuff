/**
 * Integration tests for pi-extensions/subagent/runner — agent spawn pipeline.
 *
 * Covers: runSingleAgent with mock pi CLI, including unknown agent error,
 * successful run with JSONL events, usage accumulation, progress callbacks,
 * raw event forwarding, model override, abort signal handling.
 *
 * Uses a shell script mock for `pi` (prepended to PATH).
 * Requires @mariozechner/pi-coding-agent — skips gracefully if unavailable.
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * Run with: node --experimental-strip-types --test tests/subagent-runner.test.ts
 */

import { afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	createTempDir,
	events,
	makeAgent,
	makeAgentConfigs,
	removeTempDir,
	tryImport,
} from "../pi-extensions/subagent/test/helpers.ts";
import type { AgentProgress, SingleResult, SubagentDetails } from "../pi-extensions/subagent/types.ts";

let runner: typeof import("../pi-extensions/subagent/runner.ts") | null = null;

before(async () => {
	try {
		runner = await tryImport<typeof import("../pi-extensions/subagent/runner.ts")>("./runner.ts");
	} catch {
		// runner.ts uses .js import extensions that fail under --experimental-strip-types
		// (works with tsx). Treat any transitive resolution error as "unavailable".
		runner = null;
	}
	if (!runner) console.log("⏭ Skipping runner tests: module unavailable (use tsx to run)");
});

function skip(): boolean {
	if (!runner) { console.log("  ⏭ skipped"); return true; }
	return false;
}

function testMakeDetails(mode: "single" | "parallel" | "chain" = "single") {
	return (results: SingleResult[]): SubagentDetails => ({
		mode, agentScope: "user", projectAgentsDir: null, results,
	});
}

// ---------------------------------------------------------------------------
// runSingleAgent — unknown agent
// ---------------------------------------------------------------------------

describe("runSingleAgent — unknown agent", () => {
	it("returns error for nonexistent agent", async () => {
		if (skip()) return;
		const r = await runner!.runSingleAgent({
			defaultCwd: "/tmp", agents: makeAgentConfigs(["scout", "planner"]),
			agentName: "nonexistent", task: "do something", makeDetails: testMakeDetails(),
		});
		assert.equal(r.exitCode, 1);
		assert.ok(r.stderr.includes("nonexistent"));
		assert.ok(r.stderr.includes("scout"));
		assert.equal(r.agentSource, "unknown");
	});

	it("shows none when no agents available", async () => {
		if (skip()) return;
		const r = await runner!.runSingleAgent({
			defaultCwd: "/tmp", agents: [], agentName: "x", task: "y", makeDetails: testMakeDetails(),
		});
		assert.ok(r.stderr.includes("none"));
	});
});

// ---------------------------------------------------------------------------
// runSingleAgent — spawn pipeline
// ---------------------------------------------------------------------------

describe("runSingleAgent — spawn pipeline", () => {
	let tempDir: string;
	let origPath: string | undefined;

	beforeEach(() => {
		tempDir = createTempDir("runner-test-");
		origPath = process.env.PATH;
	});

	afterEach(() => {
		if (origPath !== undefined) process.env.PATH = origPath;
		removeTempDir(tempDir);
	});

	/** Write a mock `pi` shell script that outputs JSONL events. */
	function installMockPi(jsonlEvents: object[], exitCode = 0): void {
		const lines = jsonlEvents.map((e) => JSON.stringify(e)).join("\n");
		fs.writeFileSync(
			path.join(tempDir, "pi"),
			`#!/bin/bash\nprintf '%s\\n' ${lines.split("\n").map((l) => `'${l.replace(/'/g, "'\\''")}'`).join(" ")}\nexit ${exitCode}\n`,
			{ mode: 0o755 },
		);
		process.env.PATH = `${tempDir}:${process.env.PATH}`;
	}

	it("captures assistant message from JSONL", async () => {
		if (skip()) return;
		installMockPi([events.assistantMessage("Hello!", "mock-model")]);

		const r = await runner!.runSingleAgent({
			defaultCwd: tempDir, agents: [makeAgent("scout")],
			agentName: "scout", task: "say hello", makeDetails: testMakeDetails(),
		});
		assert.equal(r.exitCode, 0);
		assert.equal(r.messages.length, 1);
		assert.equal(r.messages[0].role, "assistant");
		assert.equal(r.model, "mock-model");
	});

	it("accumulates usage across multiple messages", async () => {
		if (skip()) return;
		installMockPi([events.assistantMessage("step 1"), events.assistantMessage("step 2")]);

		const r = await runner!.runSingleAgent({
			defaultCwd: tempDir, agents: [makeAgent("scout")],
			agentName: "scout", task: "multi", makeDetails: testMakeDetails(),
		});
		assert.equal(r.usage.turns, 2);
		assert.equal(r.usage.input, 200);
		assert.equal(r.usage.output, 100);
	});

	it("tracks tool count via onProgress", async () => {
		if (skip()) return;
		installMockPi([
			events.toolStart("bash", { command: "ls" }),
			events.toolEnd("bash"),
			events.toolStart("read", { path: "/tmp/t.ts" }),
			events.toolEnd("read"),
			events.assistantMessage("done"),
		]);

		const updates: AgentProgress[] = [];
		await runner!.runSingleAgent({
			defaultCwd: tempDir, agents: [makeAgent("scout")],
			agentName: "scout", task: "tools", makeDetails: testMakeDetails(),
			onProgress: (p) => updates.push({ ...p }),
		});
		assert.ok(Math.max(...updates.map((p) => p.toolCount)) >= 2);
	});

	it("forwards raw events to onRawEvent", async () => {
		if (skip()) return;
		installMockPi([events.textDelta("hello"), events.assistantMessage("hello")]);

		const raw: Record<string, unknown>[] = [];
		await runner!.runSingleAgent({
			defaultCwd: tempDir, agents: [makeAgent("scout")],
			agentName: "scout", task: "stream", makeDetails: testMakeDetails(),
			onRawEvent: (e) => raw.push(e),
		});
		const types = raw.map((e) => e.type);
		assert.ok(types.includes("message_update"));
		assert.ok(types.includes("message_end"));
	});

	it("handles non-zero exit code", async () => {
		if (skip()) return;
		installMockPi([], 1);

		const r = await runner!.runSingleAgent({
			defaultCwd: tempDir, agents: [makeAgent("scout")],
			agentName: "scout", task: "fail", makeDetails: testMakeDetails(),
		});
		assert.equal(r.exitCode, 1);
	});

	it("applies modelOverride", async () => {
		if (skip()) return;
		installMockPi([events.assistantMessage("ok", "override-model")]);

		const r = await runner!.runSingleAgent({
			defaultCwd: tempDir, agents: [makeAgent("scout", { model: "original" })],
			agentName: "scout", task: "override", makeDetails: testMakeDetails(),
			modelOverride: "override-model",
		});
		assert.equal(r.model, "override-model");
	});

	it("sets step number in result", async () => {
		if (skip()) return;
		installMockPi([events.assistantMessage("step result")]);

		const r = await runner!.runSingleAgent({
			defaultCwd: tempDir, agents: [makeAgent("scout")],
			agentName: "scout", task: "chain step", step: 3, makeDetails: testMakeDetails(),
		});
		assert.equal(r.step, 3);
	});

	it("calls onUpdate during execution", async () => {
		if (skip()) return;
		installMockPi([events.assistantMessage("progress")]);

		let count = 0;
		await runner!.runSingleAgent({
			defaultCwd: tempDir, agents: [makeAgent("scout")],
			agentName: "scout", task: "updates", makeDetails: testMakeDetails(),
			onUpdate: () => { count++; },
		});
		assert.ok(count > 0);
	});

	it("handles abort signal", async () => {
		if (skip()) return;

		// Mock pi that sleeps forever
		fs.writeFileSync(path.join(tempDir, "pi"), "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
		process.env.PATH = `${tempDir}:${process.env.PATH}`;

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);

		const r = await runner!.runSingleAgent({
			defaultCwd: tempDir, agents: [makeAgent("scout")],
			agentName: "scout", task: "will be aborted", makeDetails: testMakeDetails(),
			signal: controller.signal,
		});
		assert.ok(r.exitCode !== 0);
		assert.equal(r.stopReason, "aborted");
		assert.ok(r.stderr.includes("aborted"));
	});

	it("succeeds with system prompt (temp file lifecycle)", async () => {
		if (skip()) return;
		installMockPi([events.assistantMessage("done")]);

		const r = await runner!.runSingleAgent({
			defaultCwd: tempDir,
			agents: [makeAgent("scout", { systemPrompt: "You are a scout. Be thorough." })],
			agentName: "scout", task: "with prompt", makeDetails: testMakeDetails(),
		});
		assert.equal(r.exitCode, 0);
	});
});
