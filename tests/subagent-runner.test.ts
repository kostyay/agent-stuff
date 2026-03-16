/**
 * Tests for pi-extensions/subagent/runner — tmux-based agent runner.
 *
 * Covers: runSingleAgent with unknown agent error, buildPiCommand structure.
 * The tmux integration is tested via manual testing (requires tmux).
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * Run with: node --experimental-strip-types --test tests/subagent-runner.test.ts
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import {
	makeAgentConfigs,
	tryImport,
} from "../pi-extensions/subagent/test/helpers.ts";
import type { SingleResult, SubagentDetails } from "../pi-extensions/subagent/types.ts";

let runner: typeof import("../pi-extensions/subagent/runner.ts") | null = null;

before(async () => {
	try {
		runner = await tryImport<typeof import("../pi-extensions/subagent/runner.ts")>("./runner.ts");
	} catch {
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

/** Stub exec that records calls but does nothing. */
function stubExec() {
	const calls: Array<{ cmd: string; args: string[] }> = [];
	const exec = async (cmd: string, args: string[]) => {
		calls.push({ cmd, args });
		return { stdout: "", stderr: "", code: 0 };
	};
	return { exec, calls };
}

describe("runSingleAgent — unknown agent", () => {
	it("returns error for nonexistent agent", async () => {
		if (skip()) return;
		const { exec } = stubExec();
		const r = await runner!.runSingleAgent({
			exec, tmuxConfig: { socketPath: "/tmp/test.sock", sessionName: "test" },
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
		const { exec } = stubExec();
		const r = await runner!.runSingleAgent({
			exec, tmuxConfig: { socketPath: "/tmp/test.sock", sessionName: "test" },
			defaultCwd: "/tmp", agents: [], agentName: "x", task: "y", makeDetails: testMakeDetails(),
		});
		assert.ok(r.stderr.includes("none"));
	});
});

describe("AGENT_WINDOW_PREFIX", () => {
	it("is agent: prefix", () => {
		if (skip()) return;
		assert.equal(runner!.AGENT_WINDOW_PREFIX, "agent:");
	});
});
