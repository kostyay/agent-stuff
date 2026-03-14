/**
 * Unit tests for pi-extensions/bgrun — background task runner extension.
 *
 * Tests pure utility functions (deriveTaskName, sanitizeName, uniqueName,
 * formatDuration) and the COMPOUND_SUBCOMMANDS set.
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * Run with: node --experimental-strip-types --test tests/bgrun.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	type BgTask,
	COMPOUND_SUBCOMMANDS,
	deriveTaskName,
	formatDuration,
	sanitizeName,
	uniqueName,
} from "../pi-extensions/bgrun.ts";

// ---------------------------------------------------------------------------
// sanitizeName
// ---------------------------------------------------------------------------

describe("sanitizeName", () => {
	it("passes through clean alphanumeric strings", () => {
		assert.equal(sanitizeName("my-task"), "my-task");
		assert.equal(sanitizeName("build.log"), "build.log");
		assert.equal(sanitizeName("task_1"), "task_1");
	});

	it("replaces special characters with hyphens", () => {
		assert.equal(sanitizeName("npm run dev"), "npm-run-dev");
		assert.equal(sanitizeName("foo@bar#baz"), "foo-bar-baz");
	});

	it("collapses consecutive hyphens", () => {
		assert.equal(sanitizeName("foo---bar"), "foo-bar");
		assert.equal(sanitizeName("a  b  c"), "a-b-c");
	});

	it("strips leading and trailing hyphens", () => {
		assert.equal(sanitizeName("-leading"), "leading");
		assert.equal(sanitizeName("trailing-"), "trailing");
		assert.equal(sanitizeName("-both-"), "both");
	});

	it("truncates to 30 characters", () => {
		const long = "a".repeat(50);
		const result = sanitizeName(long);
		assert.ok(result.length <= 30, `should be <=30 chars, got ${result.length}`);
	});

	it("returns 'task' for empty or all-invalid input", () => {
		assert.equal(sanitizeName(""), "task");
		assert.equal(sanitizeName("@#$%"), "task");
	});
});

// ---------------------------------------------------------------------------
// deriveTaskName
// ---------------------------------------------------------------------------

describe("deriveTaskName", () => {
	it("returns sanitized command for single-word commands", () => {
		assert.equal(deriveTaskName("htop"), "htop");
		assert.equal(deriveTaskName("  htop  "), "htop");
	});

	it("uses base-subcommand for non-compound subcommands", () => {
		assert.equal(deriveTaskName("git status"), "git-status");
		assert.equal(deriveTaskName("docker ps"), "docker-ps");
	});

	it("uses base-target for compound subcommands", () => {
		assert.equal(deriveTaskName("npm run dev"), "npm-dev");
		assert.equal(deriveTaskName("npm run build"), "npm-build");
		assert.equal(deriveTaskName("yarn start server"), "yarn-server");
	});

	it("falls back to subcommand when no target for compound", () => {
		assert.equal(deriveTaskName("npm run"), "npm-run");
		assert.equal(deriveTaskName("npm start"), "npm-start");
	});

	it("handles paths in commands by extracting basename", () => {
		assert.equal(deriveTaskName("/usr/bin/python3 script.py"), "python3-script.py");
		assert.equal(deriveTaskName("./node_modules/.bin/vite"), "vite");
	});

	it("handles commands with extra whitespace", () => {
		assert.equal(deriveTaskName("  npm   run   dev  "), "npm-dev");
	});
});

// ---------------------------------------------------------------------------
// COMPOUND_SUBCOMMANDS
// ---------------------------------------------------------------------------

describe("COMPOUND_SUBCOMMANDS", () => {
	it("contains all expected subcommands", () => {
		const expected = ["run", "start", "exec", "test", "build", "serve", "watch", "dev"];
		for (const cmd of expected) {
			assert.ok(COMPOUND_SUBCOMMANDS.has(cmd), `should contain '${cmd}'`);
		}
	});

	it("does not contain non-compound commands", () => {
		assert.ok(!COMPOUND_SUBCOMMANDS.has("install"));
		assert.ok(!COMPOUND_SUBCOMMANDS.has("status"));
		assert.ok(!COMPOUND_SUBCOMMANDS.has("push"));
	});
});

// ---------------------------------------------------------------------------
// uniqueName
// ---------------------------------------------------------------------------

describe("uniqueName", () => {
	function makeTasks(...names: string[]): Map<string, BgTask> {
		const map = new Map<string, BgTask>();
		for (const name of names) {
			map.set(name, { name, command: "test", startedAt: Date.now() });
		}
		return map;
	}

	it("returns desired name when no conflict", () => {
		const tasks = makeTasks("other-task");
		assert.equal(uniqueName("my-task", tasks), "my-task");
	});

	it("returns desired name with empty task map", () => {
		assert.equal(uniqueName("my-task", new Map()), "my-task");
	});

	it("appends -2 on first conflict", () => {
		const tasks = makeTasks("my-task");
		assert.equal(uniqueName("my-task", tasks), "my-task-2");
	});

	it("increments suffix on repeated conflicts", () => {
		const tasks = makeTasks("my-task", "my-task-2", "my-task-3");
		assert.equal(uniqueName("my-task", tasks), "my-task-4");
	});

	it("falls back to timestamp suffix after 98 conflicts", () => {
		const tasks = new Map<string, BgTask>();
		tasks.set("x", { name: "x", command: "test", startedAt: Date.now() });
		for (let i = 2; i < 100; i++) {
			const name = `x-${i}`;
			tasks.set(name, { name, command: "test", startedAt: Date.now() });
		}
		const result = uniqueName("x", tasks);
		assert.ok(result.startsWith("x-"), "should start with 'x-'");
		// The fallback uses Date.now(), which is a large number
		const suffix = parseInt(result.slice(2), 10);
		assert.ok(suffix >= 100, "should use timestamp, not sequential number");
	});
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
	it("formats seconds", () => {
		assert.equal(formatDuration(0), "0s");
		assert.equal(formatDuration(1_000), "1s");
		assert.equal(formatDuration(30_000), "30s");
		assert.equal(formatDuration(59_000), "59s");
	});

	it("formats minutes and seconds", () => {
		assert.equal(formatDuration(60_000), "1m0s");
		assert.equal(formatDuration(90_000), "1m30s");
		assert.equal(formatDuration(3_599_000), "59m59s");
	});

	it("formats hours and minutes", () => {
		assert.equal(formatDuration(3_600_000), "1h0m");
		assert.equal(formatDuration(5_400_000), "1h30m");
		assert.equal(formatDuration(7_200_000), "2h0m");
	});

	it("handles sub-second durations", () => {
		assert.equal(formatDuration(500), "0s");
		assert.equal(formatDuration(999), "0s");
	});
});
