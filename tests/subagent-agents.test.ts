/**
 * Integration tests for pi-extensions/subagent/agents — agent discovery.
 *
 * Covers: discoverAgents, formatAgentList, updateAgentModel, loadTeams.
 *
 * Uses temp directories with writeTestAgents() from test helpers.
 * Requires @mariozechner/pi-coding-agent — skips gracefully if unavailable.
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * Run with: node --experimental-strip-types --test tests/subagent-agents.test.ts
 */

import { afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	createTempDir,
	makeAgent,
	removeTempDir,
	tryImport,
	writeTestAgents,
} from "../pi-extensions/subagent/test/helpers.ts";

let mod: typeof import("../pi-extensions/subagent/agents.ts") | null = null;

before(async () => {
	mod = await tryImport<typeof import("../pi-extensions/subagent/agents.ts")>("./agents.ts");
	if (!mod) console.log("⏭ Skipping agents tests: pi-coding-agent not available");
});

function skip(): boolean {
	if (!mod) { console.log("  ⏭ skipped"); return true; }
	return false;
}

// ---------------------------------------------------------------------------
// discoverAgents
// ---------------------------------------------------------------------------

describe("discoverAgents", () => {
	let tempDir: string;
	let bundledDir: string;
	let projectDir: string;

	beforeEach(() => {
		tempDir = createTempDir("agents-test-");
		bundledDir = path.join(tempDir, "bundled");
		projectDir = path.join(tempDir, "project", ".pi", "agents");
	});

	afterEach(() => { removeTempDir(tempDir); });

	it("returns valid result for nonexistent dirs", () => {
		if (skip()) return;
		const r = mod!.discoverAgents("/nonexistent", "user", "/nonexistent/bundled");
		assert.ok(Array.isArray(r.agents));
	});

	it("loads bundled agents", () => {
		if (skip()) return;
		writeTestAgents(bundledDir, [
			{ name: "scout", description: "Scan code" },
			{ name: "planner", description: "Make plans" },
		]);
		const names = mod!.discoverAgents(tempDir, "project", bundledDir).agents.map((a) => a.name);
		assert.ok(names.includes("scout"));
		assert.ok(names.includes("planner"));
	});

	it("bundled agents have source bundled", () => {
		if (skip()) return;
		writeTestAgents(bundledDir, [{ name: "scout", description: "Scan" }]);
		const scout = mod!.discoverAgents(tempDir, "project", bundledDir).agents.find((a) => a.name === "scout");
		assert.equal(scout?.source, "bundled");
	});

	it("project agents override bundled with same name", () => {
		if (skip()) return;
		writeTestAgents(bundledDir, [{ name: "scout", description: "Bundled scout" }]);
		writeTestAgents(projectDir, [{ name: "scout", description: "Project scout" }]);
		const cwd = path.join(tempDir, "project");
		const scout = mod!.discoverAgents(cwd, "both", bundledDir).agents.find((a) => a.name === "scout");
		assert.equal(scout?.source, "project");
		assert.equal(scout?.description, "Project scout");
	});

	it("finds project agents dir by walking up", () => {
		if (skip()) return;
		writeTestAgents(projectDir, [{ name: "worker", description: "Does work" }]);
		const deepCwd = path.join(tempDir, "project", "src", "deep");
		fs.mkdirSync(deepCwd, { recursive: true });
		assert.equal(mod!.discoverAgents(deepCwd, "both", bundledDir).projectAgentsDir, projectDir);
	});

	it("null projectAgentsDir when no .pi/agents found", () => {
		if (skip()) return;
		assert.equal(mod!.discoverAgents(tempDir, "project").projectAgentsDir, null);
	});

	it("skips md files missing name or description", () => {
		if (skip()) return;
		fs.mkdirSync(bundledDir, { recursive: true });
		fs.writeFileSync(path.join(bundledDir, "broken.md"), "---\nname: broken\n---\n\nNo desc.\n");
		writeTestAgents(bundledDir, [{ name: "valid", description: "Valid agent" }]);
		const names = mod!.discoverAgents(tempDir, "project", bundledDir).agents.map((a) => a.name);
		assert.ok(!names.includes("broken"));
		assert.ok(names.includes("valid"));
	});

	it("parses tools from frontmatter", () => {
		if (skip()) return;
		writeTestAgents(bundledDir, [{ name: "tooled", description: "Has tools", tools: ["bash", "read", "write"] }]);
		const tooled = mod!.discoverAgents(tempDir, "project", bundledDir).agents.find((a) => a.name === "tooled");
		assert.deepEqual(tooled?.tools, ["bash", "read", "write"]);
	});

	it("parses model from frontmatter", () => {
		if (skip()) return;
		writeTestAgents(bundledDir, [{ name: "m", description: "Has model", model: "claude-sonnet" }]);
		assert.equal(mod!.discoverAgents(tempDir, "project", bundledDir).agents.find((a) => a.name === "m")?.model, "claude-sonnet");
	});

	it("scope user excludes project agents", () => {
		if (skip()) return;
		writeTestAgents(projectDir, [{ name: "proj", description: "Project" }]);
		writeTestAgents(bundledDir, [{ name: "bnd", description: "Bundled" }]);
		const names = mod!.discoverAgents(path.join(tempDir, "project"), "user", bundledDir).agents.map((a) => a.name);
		assert.ok(!names.includes("proj"));
	});
});

// ---------------------------------------------------------------------------
// formatAgentList
// ---------------------------------------------------------------------------

describe("formatAgentList", () => {
	it("returns none for empty list", () => {
		if (skip()) return;
		const r = mod!.formatAgentList([], 5);
		assert.equal(r.text, "none");
		assert.equal(r.remaining, 0);
	});

	it("all agents when under maxItems", () => {
		if (skip()) return;
		const list = [makeAgent("scout", { description: "Scan" }), makeAgent("planner", { description: "Plan" })];
		const r = mod!.formatAgentList(list, 5);
		assert.ok(r.text.includes("scout") && r.text.includes("planner"));
		assert.equal(r.remaining, 0);
	});

	it("truncates after maxItems", () => {
		if (skip()) return;
		const list = [makeAgent("a"), makeAgent("b"), makeAgent("c")];
		const r = mod!.formatAgentList(list, 2);
		assert.equal(r.remaining, 1);
	});

	it("includes source", () => {
		if (skip()) return;
		const r = mod!.formatAgentList([makeAgent("s", { source: "project" })], 5);
		assert.ok(r.text.includes("project"));
	});
});

// ---------------------------------------------------------------------------
// updateAgentModel
// ---------------------------------------------------------------------------

describe("updateAgentModel", () => {
	let tempDir: string;
	beforeEach(() => { tempDir = createTempDir("agent-model-"); });
	afterEach(() => { removeTempDir(tempDir); });

	it("updates existing model line", () => {
		if (skip()) return;
		const fp = path.join(tempDir, "agent.md");
		fs.writeFileSync(fp, "---\nname: scout\ndescription: Scan\nmodel: old\n---\n\nPrompt.\n");
		const agent = makeAgent("scout", { filePath: fp, model: "old" });
		mod!.updateAgentModel(agent, "new-model");
		const content = fs.readFileSync(fp, "utf-8");
		assert.ok(content.includes("model: new-model"));
		assert.ok(!content.includes("model: old"));
		assert.equal(agent.model, "new-model");
	});

	it("inserts model line when absent", () => {
		if (skip()) return;
		const fp = path.join(tempDir, "agent.md");
		fs.writeFileSync(fp, "---\nname: scout\ndescription: Scan\n---\n\nPrompt.\n");
		mod!.updateAgentModel(makeAgent("scout", { filePath: fp }), "inserted");
		assert.ok(fs.readFileSync(fp, "utf-8").includes("model: inserted"));
	});
});

// ---------------------------------------------------------------------------
// loadTeams
// ---------------------------------------------------------------------------

describe("loadTeams", () => {
	let tempDir: string;
	beforeEach(() => { tempDir = createTempDir("teams-"); });
	afterEach(() => { removeTempDir(tempDir); });

	it("empty object when no teams.yaml", () => {
		if (skip()) return;
		assert.deepEqual(mod!.loadTeams(null, "project"), {});
	});

	it("loads from project dir", () => {
		if (skip()) return;
		fs.mkdirSync(tempDir, { recursive: true });
		fs.writeFileSync(path.join(tempDir, "teams.yaml"), "frontend:\n  - scout\n  - reviewer\nbackend:\n  - worker\n");
		const t = mod!.loadTeams(tempDir, "project");
		assert.deepEqual(t.frontend, ["scout", "reviewer"]);
		assert.deepEqual(t.backend, ["worker"]);
	});

	it("project teams available with scope both", () => {
		if (skip()) return;
		fs.mkdirSync(tempDir, { recursive: true });
		fs.writeFileSync(path.join(tempDir, "teams.yaml"), "team1:\n  - agentA\n");
		const t = mod!.loadTeams(tempDir, "both");
		assert.deepEqual(t.team1, ["agentA"]);
	});
});
