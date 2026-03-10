/**
 * Unit tests for pi-extensions/subagent/formatting — string formatting utilities.
 *
 * Covers: shortenPath, formatTokens, formatUsageStats, formatToolCall,
 * truncate, expandTabs.
 *
 * formatting.ts only has `import type` from pi packages — truly pi-free at runtime.
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * Run with: node --experimental-strip-types --test tests/subagent-formatting.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";

import {
	expandTabs,
	formatTokens,
	formatToolCall,
	formatUsageStats,
	shortenPath,
	truncate,
} from "../pi-extensions/subagent/formatting.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function identityFg(_color: string, text: string): string {
	return text;
}

// ---------------------------------------------------------------------------
// shortenPath
// ---------------------------------------------------------------------------

describe("shortenPath", () => {
	it("replaces home directory with ~", () => {
		assert.equal(shortenPath(`${os.homedir()}/projects/foo`), "~/projects/foo");
	});

	it("leaves non-home paths unchanged", () => {
		assert.equal(shortenPath("/tmp/test"), "/tmp/test");
	});

	it("handles exact home directory", () => {
		assert.equal(shortenPath(os.homedir()), "~");
	});
});

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
	it("raw number for < 1000", () => {
		assert.equal(formatTokens(0), "0");
		assert.equal(formatTokens(500), "500");
		assert.equal(formatTokens(999), "999");
	});

	it("1k-9.9k with one decimal", () => {
		assert.equal(formatTokens(1000), "1.0k");
		assert.equal(formatTokens(1500), "1.5k");
	});

	it("10k-999k as rounded k", () => {
		assert.equal(formatTokens(10000), "10k");
		assert.equal(formatTokens(150000), "150k");
	});

	it(">= 1M with one decimal", () => {
		assert.equal(formatTokens(1000000), "1.0M");
		assert.equal(formatTokens(1500000), "1.5M");
	});
});

// ---------------------------------------------------------------------------
// formatUsageStats
// ---------------------------------------------------------------------------

describe("formatUsageStats", () => {
	it("empty string for all-zero usage", () => {
		assert.equal(formatUsageStats({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }), "");
	});

	it("includes non-zero fields", () => {
		const r = formatUsageStats({ input: 1500, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.0123 });
		assert.ok(r.includes("↑1.5k"));
		assert.ok(r.includes("↓500"));
		assert.ok(r.includes("$0.0123"));
		assert.ok(!r.includes("R"));
	});

	it("includes turns (pluralized)", () => {
		const r = formatUsageStats({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 3 });
		assert.ok(r.includes("3 turns"));
	});

	it("singularizes 1 turn", () => {
		const r = formatUsageStats({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 });
		assert.ok(r.includes("1 turn"));
		assert.ok(!r.includes("1 turns"));
	});

	it("includes model when provided", () => {
		const r = formatUsageStats({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0 }, "claude-sonnet");
		assert.ok(r.includes("claude-sonnet"));
	});

	it("includes contextTokens when present", () => {
		const r = formatUsageStats({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 50000 });
		assert.ok(r.includes("ctx:50k"));
	});

	it("includes cache read/write", () => {
		const r = formatUsageStats({ input: 0, output: 0, cacheRead: 5000, cacheWrite: 2000, cost: 0 });
		assert.ok(r.includes("R5.0k"));
		assert.ok(r.includes("W2.0k"));
	});
});

// ---------------------------------------------------------------------------
// formatToolCall
// ---------------------------------------------------------------------------

describe("formatToolCall", () => {
	it("bash: $ prefix + command", () => {
		const r = formatToolCall("bash", { command: "ls -la" }, identityFg);
		assert.ok(r.includes("$ ") && r.includes("ls -la"));
	});

	it("bash: truncates long commands", () => {
		const r = formatToolCall("bash", { command: "a".repeat(100) }, identityFg);
		assert.ok(r.includes("..."));
	});

	it("read: shows file path", () => {
		const r = formatToolCall("read", { path: "/tmp/test.ts" }, identityFg);
		assert.ok(r.includes("read ") && r.includes("/tmp/test.ts"));
	});

	it("read: shows offset:limit range", () => {
		const r = formatToolCall("read", { path: "/tmp/t.ts", offset: 10, limit: 20 }, identityFg);
		assert.ok(r.includes(":10-29"));
	});

	it("read: supports file_path alias", () => {
		const r = formatToolCall("read", { file_path: "/tmp/test.ts" }, identityFg);
		assert.ok(r.includes("/tmp/test.ts"));
	});

	it("write: shows line count", () => {
		const r = formatToolCall("write", { path: "/tmp/o.ts", content: "a\nb\nc" }, identityFg);
		assert.ok(r.includes("write ") && r.includes("3 lines"));
	});

	it("edit: shows path", () => {
		assert.ok(formatToolCall("edit", { path: "/tmp/e.ts" }, identityFg).includes("edit "));
	});

	it("ls: shows path", () => {
		assert.ok(formatToolCall("ls", { path: "/tmp" }, identityFg).includes("ls "));
	});

	it("find: shows pattern", () => {
		const r = formatToolCall("find", { pattern: "*.ts", path: "/src" }, identityFg);
		assert.ok(r.includes("find ") && r.includes("*.ts"));
	});

	it("grep: shows pattern in slashes", () => {
		const r = formatToolCall("grep", { pattern: "TODO", path: "/src" }, identityFg);
		assert.ok(r.includes("grep ") && r.includes("/TODO/"));
	});

	it("unknown tool: name + truncated args", () => {
		assert.ok(formatToolCall("custom", { key: "value" }, identityFg).includes("custom"));
	});

	it("shortens home directory in paths", () => {
		const r = formatToolCall("read", { path: `${os.homedir()}/code/t.ts` }, identityFg);
		assert.ok(r.includes("~/code/t.ts"));
	});

	it("uses correct theme colors for bash", () => {
		const colors: string[] = [];
		const captureFg = (c: string, t: string) => { colors.push(c); return t; };
		formatToolCall("bash", { command: "echo hi" }, captureFg);
		assert.ok(colors.includes("muted"));
		assert.ok(colors.includes("toolOutput"));
	});
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe("truncate", () => {
	it("short strings unchanged", () => { assert.equal(truncate("hello", 10), "hello"); });
	it("truncates with ellipsis", () => { assert.equal(truncate("hello world", 6), "hello…"); });
	it("exact-length unchanged", () => { assert.equal(truncate("hello", 5), "hello"); });
	it("max = 1", () => { assert.equal(truncate("abc", 1), "…"); });
});

// ---------------------------------------------------------------------------
// expandTabs
// ---------------------------------------------------------------------------

describe("expandTabs", () => {
	it("replaces tabs with two spaces", () => { assert.equal(expandTabs("\thello\tworld"), "  hello  world"); });
	it("unchanged when no tabs", () => { assert.equal(expandTabs("no tabs"), "no tabs"); });
	it("empty string", () => { assert.equal(expandTabs(""), ""); });
	it("multiple consecutive tabs", () => { assert.equal(expandTabs("\t\t"), "    "); });
});
