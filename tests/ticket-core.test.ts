/**
 * Unit tests for ticket-core — the pure logic layer of the ticket tracker.
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * Run with: node --experimental-strip-types --test tests/ticket-core.test.ts
 */

import { describe, it, before, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
	type TicketFrontMatter,
	type TicketRecord,
	VALID_STATUSES,
	VALID_TYPES,
	buildRefinePrompt,
	buildSearchText,
	buildWorkPrompt,
	derivePrefix,
	ensureDir,
	filterTickets,
	findJsonEnd,
	formatTicketLine,
	garbageCollect,
	generateId,
	getProjectPrefix,
	getReadyTickets,
	getTicketPath,
	getTicketsDir,
	isError,
	listTickets,
	listTicketsSync,
	parseBody,
	parseTicket,
	parseTicketFrontMatter,
	readSettings,
	readTicketFile,
	resolveId,
	serializeForAgent,
	serializeListForAgent,
	serializeTicket,
	sortTickets,
	splitContent,
	statusIcon,
	writeTicketFile,
} from "../pi-extensions/ticket/ticket-core.ts";

// ── Helpers ────────────────────────────────────────────────────────────

/** Create a temporary directory for test isolation. */
async function makeTmpDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "ticket-test-"));
}

/** Create a minimal TicketRecord for testing. */
function makeTicket(overrides: Partial<TicketRecord> = {}): TicketRecord {
	return {
		id: "as-a1b2",
		title: "Test ticket",
		status: "open",
		type: "task",
		priority: 2,
		tests_passed: false,
		created_at: "2026-03-01T22:00:00.000Z",
		description: "",
		design: "",
		acceptance: "",
		tests: "",
		notes: "",
		...overrides,
	};
}

/** Create a minimal TicketFrontMatter for testing. */
function makeFM(overrides: Partial<TicketFrontMatter> = {}): TicketFrontMatter {
	return {
		id: "as-a1b2",
		title: "Test ticket",
		status: "open",
		type: "task",
		priority: 2,
		tests_passed: false,
		created_at: "2026-03-01T22:00:00.000Z",
		...overrides,
	};
}

// ════════════════════════════════════════════════════════════════════════
// ID Generation
// ════════════════════════════════════════════════════════════════════════

describe("derivePrefix", () => {
	it("derives from multi-word hyphenated name", () => {
		assert.equal(derivePrefix("agent-stuff"), "as");
	});

	it("derives from multi-word underscore name", () => {
		assert.equal(derivePrefix("my_cool_app"), "mca");
	});

	it("truncates to 3 chars for long names", () => {
		assert.equal(derivePrefix("one-two-three-four"), "ott");
	});

	it("uses first 2 chars for single-word name", () => {
		assert.equal(derivePrefix("kticket"), "kt");
	});

	it("handles short single-word name", () => {
		assert.equal(derivePrefix("pi"), "pi");
	});
});

describe("getProjectPrefix", () => {
	it("uses directory basename", () => {
		assert.equal(getProjectPrefix("/Users/kostya/personal/agent-stuff"), "as");
	});

	it("handles simple dir", () => {
		assert.equal(getProjectPrefix("/foo"), "fo");
	});
});

describe("generateId", () => {
	let tmpDir: string;

	before(async () => {
		tmpDir = await makeTmpDir();
	});

	after(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("generates an ID with the given prefix", async () => {
		const id = await generateId(tmpDir, "as");
		assert.match(id, /^as-[a-f0-9]{4}$/);
	});

	it("generates unique IDs", async () => {
		const ids = new Set<string>();
		for (let i = 0; i < 10; i++) {
			ids.add(await generateId(tmpDir, "as"));
		}
		assert.equal(ids.size, 10);
	});

	it("avoids collision with existing files", async () => {
		// Create a file to force collision avoidance
		await fs.writeFile(path.join(tmpDir, "xx-0000.md"), "");
		const id = await generateId(tmpDir, "xx");
		assert.notEqual(id, "xx-0000");
		assert.match(id, /^xx-[a-f0-9]{4}$/);
	});
});

describe("resolveId", () => {
	let tmpDir: string;

	before(async () => {
		tmpDir = await makeTmpDir();
		await fs.writeFile(path.join(tmpDir, "as-a1b2.md"), "{}");
		await fs.writeFile(path.join(tmpDir, "as-c3d4.md"), "{}");
		await fs.writeFile(path.join(tmpDir, "as-a1ff.md"), "{}");
	});

	after(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("resolves exact match", () => {
		const result = resolveId("as-a1b2", tmpDir);
		assert.equal(result, "as-a1b2");
	});

	it("resolves partial match (unique suffix)", () => {
		const result = resolveId("c3d4", tmpDir);
		assert.equal(result, "as-c3d4");
	});

	it("returns error for ambiguous partial match", () => {
		const result = resolveId("a1", tmpDir);
		assert.ok(typeof result === "object" && "error" in result);
		assert.ok(result.error.includes("Ambiguous"));
	});

	it("returns error for empty input", () => {
		const result = resolveId("", tmpDir);
		assert.ok(typeof result === "object" && "error" in result);
	});

	it("returns error for non-existent ID", () => {
		const result = resolveId("zzzz", tmpDir);
		assert.ok(typeof result === "object" && "error" in result);
		assert.ok(result.error.includes("not found"));
	});

	it("returns error for non-existent directory", () => {
		const result = resolveId("a1b2", "/nonexistent/dir");
		assert.ok(typeof result === "object" && "error" in result);
	});
});

// ════════════════════════════════════════════════════════════════════════
// File Format Parsing
// ════════════════════════════════════════════════════════════════════════

describe("findJsonEnd", () => {
	it("finds end of simple object", () => {
		assert.equal(findJsonEnd('{"a": 1}rest'), 7);
	});

	it("finds end of nested object", () => {
		assert.equal(findJsonEnd('{"a": {"b": 2}}rest'), 14);
	});

	it("handles strings with braces", () => {
		assert.equal(findJsonEnd('{"a": "{"}rest'), 9);
	});

	it("handles escaped quotes in strings", () => {
		assert.equal(findJsonEnd('{"a": "val\\"ue"}rest'), 15);
	});

	it("returns -1 for unclosed object", () => {
		assert.equal(findJsonEnd('{"a": 1'), -1);
	});

	it("returns -1 for empty string", () => {
		assert.equal(findJsonEnd(""), -1);
	});

	it("handles array values", () => {
		const content = '{"deps": ["a", "b"]}rest';
		assert.equal(findJsonEnd(content), 19);
	});
});

describe("splitContent", () => {
	it("splits JSON frontmatter from body", () => {
		const content = '{"id": "test"}\n\nSome body text';
		const result = splitContent(content);
		assert.equal(result.json, '{"id": "test"}');
		assert.equal(result.body, "Some body text");
	});

	it("returns empty json for non-JSON content", () => {
		const content = "Just plain markdown";
		const result = splitContent(content);
		assert.equal(result.json, "");
		assert.equal(result.body, "Just plain markdown");
	});

	it("strips leading newlines from body", () => {
		const content = '{"id": "test"}\n\n\nBody';
		const result = splitContent(content);
		assert.equal(result.body, "Body");
	});

	it("handles content with no body", () => {
		const content = '{"id": "test"}';
		const result = splitContent(content);
		assert.equal(result.json, '{"id": "test"}');
		assert.equal(result.body, "");
	});
});

describe("parseBody", () => {
	it("parses description (text before any section header)", () => {
		const body = "This is the description.\nSecond line.";
		const result = parseBody(body);
		assert.equal(result.description, "This is the description.\nSecond line.");
	});

	it("parses design section", () => {
		const body = "Desc\n\n## Design\n\nDesign notes here.";
		const result = parseBody(body);
		assert.equal(result.description, "Desc");
		assert.equal(result.design, "Design notes here.");
	});

	it("parses acceptance criteria section", () => {
		const body = "## Acceptance Criteria\n\n- Criterion 1\n- Criterion 2";
		const result = parseBody(body);
		assert.equal(result.acceptance, "- Criterion 1\n- Criterion 2");
	});

	it("parses tests section", () => {
		const body = "## Tests\n\n- TestLogin\n- TestLogout";
		const result = parseBody(body);
		assert.equal(result.tests, "- TestLogin\n- TestLogout");
	});

	it("parses notes section", () => {
		const body = "## Notes\n\n**2026-03-01**\nFirst note.";
		const result = parseBody(body);
		assert.equal(result.notes, "**2026-03-01**\nFirst note.");
	});

	it("parses multiple sections", () => {
		const body = [
			"Description text",
			"",
			"## Design",
			"",
			"Design notes",
			"",
			"## Tests",
			"",
			"- Test1",
			"",
			"## Notes",
			"",
			"A note",
		].join("\n");
		const result = parseBody(body);
		assert.equal(result.description, "Description text");
		assert.equal(result.design, "Design notes");
		assert.equal(result.tests, "- Test1");
		assert.equal(result.notes, "A note");
	});

	it("returns empty sections for empty body", () => {
		const result = parseBody("");
		assert.equal(result.description, "");
		assert.equal(result.design, "");
		assert.equal(result.acceptance, "");
		assert.equal(result.tests, "");
		assert.equal(result.notes, "");
	});
});

describe("parseTicketFrontMatter", () => {
	it("parses valid JSON frontmatter", () => {
		const json = JSON.stringify({
			id: "as-a1b2",
			title: "My ticket",
			status: "in_progress",
			type: "feature",
			priority: 1,
			parent: "as-epic1",
			deps: ["as-dep1"],
			assignee: "session-123",
			tests_passed: true,
			created_at: "2026-03-01T22:00:00.000Z",
		});
		const result = parseTicketFrontMatter(json, "fallback");
		assert.equal(result.id, "as-a1b2");
		assert.equal(result.title, "My ticket");
		assert.equal(result.status, "in_progress");
		assert.equal(result.type, "feature");
		assert.equal(result.priority, 1);
		assert.equal(result.parent, "as-epic1");
		assert.deepEqual(result.deps, ["as-dep1"]);
		assert.equal(result.assignee, "session-123");
		assert.equal(result.tests_passed, true);
	});

	it("returns defaults for empty string", () => {
		const result = parseTicketFrontMatter("", "fallback-id");
		assert.equal(result.id, "fallback-id");
		assert.equal(result.title, "");
		assert.equal(result.status, "open");
		assert.equal(result.type, "task");
		assert.equal(result.priority, 2);
		assert.equal(result.tests_passed, false);
	});

	it("returns defaults for invalid JSON", () => {
		const result = parseTicketFrontMatter("{bad json", "fb");
		assert.equal(result.id, "fb");
		assert.equal(result.status, "open");
	});

	it("falls back to defaults for invalid field values", () => {
		const json = JSON.stringify({
			status: "invalid_status",
			type: "invalid_type",
			priority: "not a number",
		});
		const result = parseTicketFrontMatter(json, "fb");
		assert.equal(result.status, "open");
		assert.equal(result.type, "task");
		assert.equal(result.priority, 2);
	});

	it("filters non-string deps", () => {
		const json = JSON.stringify({ deps: ["valid", 123, null, "also-valid"] });
		const result = parseTicketFrontMatter(json, "fb");
		assert.deepEqual(result.deps, ["valid", "also-valid"]);
	});

	it("uses fallback ID when id is missing", () => {
		const json = JSON.stringify({ title: "No ID" });
		const result = parseTicketFrontMatter(json, "my-fallback");
		assert.equal(result.id, "my-fallback");
	});
});

describe("parseTicket", () => {
	it("parses a full ticket file", () => {
		const content = [
			JSON.stringify({
				id: "as-a1b2",
				title: "Full ticket",
				status: "open",
				type: "feature",
				priority: 1,
				created_at: "2026-03-01T22:00:00.000Z",
				tests_passed: false,
			}, null, 2),
			"",
			"The description.",
			"",
			"## Design",
			"",
			"The design.",
			"",
			"## Tests",
			"",
			"- TestOne",
		].join("\n");

		const ticket = parseTicket(content, "fallback");
		assert.equal(ticket.id, "as-a1b2");
		assert.equal(ticket.title, "Full ticket");
		assert.equal(ticket.description, "The description.");
		assert.equal(ticket.design, "The design.");
		assert.equal(ticket.tests, "- TestOne");
	});

	it("handles content with only frontmatter", () => {
		const content = JSON.stringify({ id: "t1", title: "Bare" });
		const ticket = parseTicket(content, "t1");
		assert.equal(ticket.title, "Bare");
		assert.equal(ticket.description, "");
	});
});

// ════════════════════════════════════════════════════════════════════════
// Serialization
// ════════════════════════════════════════════════════════════════════════

describe("serializeTicket", () => {
	it("produces valid JSON frontmatter + body", () => {
		const ticket = makeTicket({
			description: "A description",
			design: "A design",
			tests: "- Test1",
		});
		const content = serializeTicket(ticket);

		// Should be parseable back
		const parsed = parseTicket(content, "fallback");
		assert.equal(parsed.id, ticket.id);
		assert.equal(parsed.title, ticket.title);
		assert.equal(parsed.status, ticket.status);
		assert.equal(parsed.description, "A description");
		assert.equal(parsed.design, "A design");
		assert.equal(parsed.tests, "- Test1");
	});

	it("omits empty optional fields", () => {
		const ticket = makeTicket();
		const content = serializeTicket(ticket);
		assert.ok(!content.includes('"parent"'));
		assert.ok(!content.includes('"deps"'));
		assert.ok(!content.includes('"assignee"'));
	});

	it("includes optional fields when set", () => {
		const ticket = makeTicket({
			parent: "as-epic1",
			deps: ["as-dep1"],
			assignee: "session-1",
			external_ref: "gh-42",
		});
		const content = serializeTicket(ticket);
		assert.ok(content.includes('"parent": "as-epic1"'));
		assert.ok(content.includes('"as-dep1"'));
		assert.ok(content.includes('"assignee": "session-1"'));
		assert.ok(content.includes('"external_ref": "gh-42"'));
	});

	it("includes markdown sections when present", () => {
		const ticket = makeTicket({
			description: "Desc",
			design: "Design",
			acceptance: "AC",
			tests: "Tests",
			notes: "Notes",
		});
		const content = serializeTicket(ticket);
		assert.ok(content.includes("Desc"));
		assert.ok(content.includes("## Design"));
		assert.ok(content.includes("## Acceptance Criteria"));
		assert.ok(content.includes("## Tests"));
		assert.ok(content.includes("## Notes"));
	});

	it("does not include section headers when section is empty", () => {
		const ticket = makeTicket();
		const content = serializeTicket(ticket);
		assert.ok(!content.includes("## Design"));
		assert.ok(!content.includes("## Tests"));
	});
});

describe("round-trip: serialize then parse", () => {
	it("preserves all fields through round-trip", () => {
		const original = makeTicket({
			id: "rt-1234",
			title: "Round trip test",
			status: "in_progress",
			type: "feature",
			priority: 0,
			parent: "rt-0000",
			deps: ["rt-aaaa", "rt-bbbb"],
			links: ["rt-cccc"],
			assignee: "sess-42",
			external_ref: "gh-99",
			tests_passed: true,
			created_at: "2026-01-15T10:00:00.000Z",
			description: "Description line 1\nDescription line 2",
			design: "Design paragraph",
			acceptance: "- AC1\n- AC2",
			tests: "- Test1\n- Test2",
			notes: "**2026-01-15T10:00:00Z**\nA note.",
		});

		const serialized = serializeTicket(original);
		const parsed = parseTicket(serialized, "fallback");

		assert.equal(parsed.id, original.id);
		assert.equal(parsed.title, original.title);
		assert.equal(parsed.status, original.status);
		assert.equal(parsed.type, original.type);
		assert.equal(parsed.priority, original.priority);
		assert.equal(parsed.parent, original.parent);
		assert.deepEqual(parsed.deps, original.deps);
		assert.deepEqual(parsed.links, original.links);
		assert.equal(parsed.assignee, original.assignee);
		assert.equal(parsed.external_ref, original.external_ref);
		assert.equal(parsed.tests_passed, original.tests_passed);
		assert.equal(parsed.description, original.description);
		assert.equal(parsed.design, original.design);
		assert.equal(parsed.acceptance, original.acceptance);
		assert.equal(parsed.tests, original.tests);
		assert.equal(parsed.notes, original.notes);
	});
});

// ════════════════════════════════════════════════════════════════════════
// Sorting & Queries
// ════════════════════════════════════════════════════════════════════════

describe("sortTickets", () => {
	it("puts in_progress before open before closed", () => {
		const tickets = [
			makeFM({ id: "1", status: "closed" }),
			makeFM({ id: "2", status: "open" }),
			makeFM({ id: "3", status: "in_progress" }),
		];
		const sorted = sortTickets(tickets);
		assert.deepEqual(sorted.map((t) => t.id), ["3", "2", "1"]);
	});

	it("sorts by priority within same status", () => {
		const tickets = [
			makeFM({ id: "low", status: "open", priority: 3 }),
			makeFM({ id: "high", status: "open", priority: 0 }),
			makeFM({ id: "med", status: "open", priority: 2 }),
		];
		const sorted = sortTickets(tickets);
		assert.deepEqual(sorted.map((t) => t.id), ["high", "med", "low"]);
	});

	it("sorts by created_at within same status and priority", () => {
		const tickets = [
			makeFM({ id: "newer", status: "open", priority: 2, created_at: "2026-03-02T00:00:00Z" }),
			makeFM({ id: "older", status: "open", priority: 2, created_at: "2026-03-01T00:00:00Z" }),
		];
		const sorted = sortTickets(tickets);
		assert.deepEqual(sorted.map((t) => t.id), ["older", "newer"]);
	});

	it("does not mutate original array", () => {
		const tickets = [
			makeFM({ id: "b", status: "closed" }),
			makeFM({ id: "a", status: "open" }),
		];
		const original = [...tickets];
		sortTickets(tickets);
		assert.deepEqual(tickets.map((t) => t.id), original.map((t) => t.id));
	});
});

describe("getReadyTickets", () => {
	it("returns tickets with no deps", () => {
		const tickets = [
			makeFM({ id: "a", status: "open" }),
			makeFM({ id: "b", status: "open" }),
		];
		const ready = getReadyTickets(tickets);
		assert.equal(ready.length, 2);
	});

	it("excludes tickets with unresolved deps", () => {
		const tickets = [
			makeFM({ id: "a", status: "open" }),
			makeFM({ id: "b", status: "open", deps: ["a"] }),
		];
		const ready = getReadyTickets(tickets);
		assert.equal(ready.length, 1);
		assert.equal(ready[0].id, "a");
	});

	it("includes tickets whose deps are all closed", () => {
		const tickets = [
			makeFM({ id: "a", status: "closed" }),
			makeFM({ id: "b", status: "open", deps: ["a"] }),
		];
		const ready = getReadyTickets(tickets);
		assert.equal(ready.length, 1);
		assert.equal(ready[0].id, "b");
	});

	it("excludes closed tickets from results", () => {
		const tickets = [
			makeFM({ id: "a", status: "closed" }),
			makeFM({ id: "b", status: "open" }),
		];
		const ready = getReadyTickets(tickets);
		assert.equal(ready.length, 1);
		assert.equal(ready[0].id, "b");
	});

	it("handles mixed deps (some closed, some open)", () => {
		const tickets = [
			makeFM({ id: "a", status: "closed" }),
			makeFM({ id: "b", status: "open" }),
			makeFM({ id: "c", status: "open", deps: ["a", "b"] }),
		];
		const ready = getReadyTickets(tickets);
		// c depends on b which is open, so c is not ready
		assert.equal(ready.length, 1);
		assert.equal(ready[0].id, "b");
	});

	it("returns in_progress tickets that are ready", () => {
		const tickets = [
			makeFM({ id: "a", status: "in_progress" }),
		];
		const ready = getReadyTickets(tickets);
		assert.equal(ready.length, 1);
	});
});

// ════════════════════════════════════════════════════════════════════════
// Formatting
// ════════════════════════════════════════════════════════════════════════

describe("statusIcon", () => {
	it("returns ○ for open", () => assert.equal(statusIcon("open"), "○"));
	it("returns ● for in_progress", () => assert.equal(statusIcon("in_progress"), "●"));
	it("returns ✓ for closed", () => assert.equal(statusIcon("closed"), "✓"));
});

describe("formatTicketLine", () => {
	it("formats a basic ticket", () => {
		const line = formatTicketLine(makeFM());
		assert.ok(line.includes("○"));
		assert.ok(line.includes("as-a1b2"));
		assert.ok(line.includes("Test ticket"));
		assert.ok(line.includes("task"));
		assert.ok(line.includes("p2"));
	});

	it("includes parent reference", () => {
		const line = formatTicketLine(makeFM({ parent: "as-epic1" }));
		assert.ok(line.includes("↑as-epic1"));
	});

	it("includes assignee", () => {
		const line = formatTicketLine(makeFM({ assignee: "session-42" }));
		assert.ok(line.includes("@session-42"));
	});

	it("shows (untitled) for empty title", () => {
		const line = formatTicketLine(makeFM({ title: "" }));
		assert.ok(line.includes("(untitled)"));
	});
});

describe("serializeForAgent", () => {
	it("returns valid JSON", () => {
		const ticket = makeTicket();
		const json = serializeForAgent(ticket);
		const parsed = JSON.parse(json);
		assert.equal(parsed.id, "as-a1b2");
		assert.equal(parsed.title, "Test ticket");
	});
});

describe("serializeListForAgent", () => {
	it("groups tickets by status", () => {
		const tickets = [
			makeFM({ id: "1", status: "open" }),
			makeFM({ id: "2", status: "in_progress" }),
			makeFM({ id: "3", status: "closed" }),
		];
		const json = serializeListForAgent(tickets);
		const parsed = JSON.parse(json);
		assert.equal(parsed.open.length, 1);
		assert.equal(parsed.in_progress.length, 1);
		assert.equal(parsed.closed.length, 1);
		assert.equal(parsed.open[0].id, "1");
		assert.equal(parsed.in_progress[0].id, "2");
		assert.equal(parsed.closed[0].id, "3");
	});
});

// ════════════════════════════════════════════════════════════════════════
// Search
// ════════════════════════════════════════════════════════════════════════

describe("buildSearchText", () => {
	it("includes id, title, type, status, priority", () => {
		const text = buildSearchText(makeFM());
		assert.ok(text.includes("as-a1b2"));
		assert.ok(text.includes("Test ticket"));
		assert.ok(text.includes("task"));
		assert.ok(text.includes("open"));
		assert.ok(text.includes("p2"));
	});

	it("includes parent and assignee when set", () => {
		const text = buildSearchText(makeFM({ parent: "as-epic1", assignee: "sess-1" }));
		assert.ok(text.includes("as-epic1"));
		assert.ok(text.includes("sess-1"));
	});
});

describe("filterTickets", () => {
	const tickets = [
		makeFM({ id: "as-a1b2", title: "Add auth", type: "feature", status: "open" }),
		makeFM({ id: "as-c3d4", title: "Fix login bug", type: "bug", status: "in_progress" }),
		makeFM({ id: "as-e5f6", title: "Chore cleanup", type: "chore", status: "closed" }),
	];

	it("returns all tickets for empty query", () => {
		assert.equal(filterTickets(tickets, "").length, 3);
		assert.equal(filterTickets(tickets, "  ").length, 3);
	});

	it("filters by title substring", () => {
		const result = filterTickets(tickets, "auth");
		assert.equal(result.length, 1);
		assert.equal(result[0].id, "as-a1b2");
	});

	it("filters by ID", () => {
		const result = filterTickets(tickets, "c3d4");
		assert.equal(result.length, 1);
		assert.equal(result[0].id, "as-c3d4");
	});

	it("filters by type", () => {
		const result = filterTickets(tickets, "bug");
		assert.equal(result.length, 1);
		assert.equal(result[0].id, "as-c3d4");
	});

	it("filters by multiple tokens (AND logic)", () => {
		const result = filterTickets(tickets, "bug login");
		assert.equal(result.length, 1);
		assert.equal(result[0].id, "as-c3d4");
	});

	it("is case-insensitive", () => {
		const result = filterTickets(tickets, "ADD AUTH");
		assert.equal(result.length, 1);
		assert.equal(result[0].id, "as-a1b2");
	});

	it("returns empty for no matches", () => {
		assert.equal(filterTickets(tickets, "nonexistent").length, 0);
	});
});

// ════════════════════════════════════════════════════════════════════════
// Prompt Helpers
// ════════════════════════════════════════════════════════════════════════

describe("buildWorkPrompt", () => {
	it("includes ticket ID and title", () => {
		const prompt = buildWorkPrompt(makeFM({ id: "as-a1b2", title: "My task" }));
		assert.ok(prompt.includes("as-a1b2"));
		assert.ok(prompt.includes("My task"));
	});

	it("handles untitled tickets", () => {
		const prompt = buildWorkPrompt(makeFM({ title: "" }));
		assert.ok(prompt.includes("(untitled)"));
	});
});

describe("buildRefinePrompt", () => {
	it("includes ticket ID and title", () => {
		const prompt = buildRefinePrompt(makeFM({ id: "as-a1b2", title: "My task" }));
		assert.ok(prompt.includes("as-a1b2"));
		assert.ok(prompt.includes("My task"));
	});

	it("instructs not to rewrite", () => {
		const prompt = buildRefinePrompt(makeFM());
		assert.ok(prompt.includes("Do not rewrite"));
	});
});

// ════════════════════════════════════════════════════════════════════════
// File I/O (with temp directories)
// ════════════════════════════════════════════════════════════════════════

describe("getTicketsDir", () => {
	it("appends .tickets to cwd", () => {
		assert.equal(getTicketsDir("/my/project"), path.join("/my/project", ".tickets"));
	});
});

describe("getTicketPath", () => {
	it("appends id.md", () => {
		assert.equal(getTicketPath("/dir", "as-a1b2"), path.join("/dir", "as-a1b2.md"));
	});
});

describe("writeTicketFile + readTicketFile", () => {
	let tmpDir: string;

	before(async () => {
		tmpDir = await makeTmpDir();
	});

	after(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("writes and reads back a ticket", async () => {
		const ticket = makeTicket({
			id: "io-test",
			title: "IO test ticket",
			description: "Some description",
			design: "The design",
		});
		const fp = getTicketPath(tmpDir, ticket.id);
		await writeTicketFile(fp, ticket);
		const read = await readTicketFile(fp, ticket.id);

		assert.equal(read.id, ticket.id);
		assert.equal(read.title, ticket.title);
		assert.equal(read.description, ticket.description);
		assert.equal(read.design, ticket.design);
	});
});

describe("listTickets / listTicketsSync", () => {
	let tmpDir: string;

	before(async () => {
		tmpDir = await makeTmpDir();
		await writeTicketFile(
			getTicketPath(tmpDir, "as-0001"),
			makeTicket({ id: "as-0001", title: "First", status: "open", priority: 2 }),
		);
		await writeTicketFile(
			getTicketPath(tmpDir, "as-0002"),
			makeTicket({ id: "as-0002", title: "Second", status: "in_progress", priority: 1 }),
		);
		await writeTicketFile(
			getTicketPath(tmpDir, "as-0003"),
			makeTicket({ id: "as-0003", title: "Third", status: "closed", priority: 0 }),
		);
		// Non-ticket file should be ignored
		await fs.writeFile(path.join(tmpDir, "settings.json"), "{}");
		await fs.writeFile(path.join(tmpDir, "README.txt"), "not a ticket");
	});

	after(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("lists all ticket files (async)", async () => {
		const tickets = await listTickets(tmpDir);
		assert.equal(tickets.length, 3);
	});

	it("returns sorted results (async)", async () => {
		const tickets = await listTickets(tmpDir);
		// in_progress first, then open, then closed
		assert.equal(tickets[0].id, "as-0002"); // in_progress
		assert.equal(tickets[1].id, "as-0001"); // open
		assert.equal(tickets[2].id, "as-0003"); // closed
	});

	it("lists all ticket files (sync)", () => {
		const tickets = listTicketsSync(tmpDir);
		assert.equal(tickets.length, 3);
	});

	it("returns empty for non-existent dir", async () => {
		assert.deepEqual(await listTickets("/nonexistent"), []);
		assert.deepEqual(listTicketsSync("/nonexistent"), []);
	});
});

// ════════════════════════════════════════════════════════════════════════
// Settings & GC
// ════════════════════════════════════════════════════════════════════════

describe("readSettings", () => {
	let tmpDir: string;

	before(async () => {
		tmpDir = await makeTmpDir();
	});

	after(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("returns defaults when settings.json missing", async () => {
		const settings = await readSettings(tmpDir);
		assert.equal(settings.gc, true);
		assert.equal(settings.gcDays, 7);
	});

	it("reads custom settings", async () => {
		await fs.writeFile(
			path.join(tmpDir, "settings.json"),
			JSON.stringify({ gc: false, gcDays: 30 }),
		);
		const settings = await readSettings(tmpDir);
		assert.equal(settings.gc, false);
		assert.equal(settings.gcDays, 30);
	});

	it("fills in defaults for partial settings", async () => {
		await fs.writeFile(
			path.join(tmpDir, "settings.json"),
			JSON.stringify({ gcDays: 14 }),
		);
		const settings = await readSettings(tmpDir);
		assert.equal(settings.gc, true); // default
		assert.equal(settings.gcDays, 14);
	});
});

describe("garbageCollect", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await makeTmpDir();
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("deletes old closed tickets", async () => {
		const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
		await writeTicketFile(
			getTicketPath(tmpDir, "gc-old"),
			makeTicket({ id: "gc-old", status: "closed", created_at: oldDate }),
		);
		await garbageCollect(tmpDir, { gc: true, gcDays: 7 });

		const tickets = await listTickets(tmpDir);
		assert.equal(tickets.length, 0);
	});

	it("keeps recent closed tickets", async () => {
		const recentDate = new Date().toISOString();
		await writeTicketFile(
			getTicketPath(tmpDir, "gc-recent"),
			makeTicket({ id: "gc-recent", status: "closed", created_at: recentDate }),
		);
		await garbageCollect(tmpDir, { gc: true, gcDays: 7 });

		const tickets = await listTickets(tmpDir);
		assert.equal(tickets.length, 1);
	});

	it("never deletes open tickets", async () => {
		const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
		await writeTicketFile(
			getTicketPath(tmpDir, "gc-open"),
			makeTicket({ id: "gc-open", status: "open", created_at: oldDate }),
		);
		await garbageCollect(tmpDir, { gc: true, gcDays: 7 });

		const tickets = await listTickets(tmpDir);
		assert.equal(tickets.length, 1);
	});

	it("does nothing when gc is disabled", async () => {
		const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
		await writeTicketFile(
			getTicketPath(tmpDir, "gc-disabled"),
			makeTicket({ id: "gc-disabled", status: "closed", created_at: oldDate }),
		);
		await garbageCollect(tmpDir, { gc: false, gcDays: 7 });

		const tickets = await listTickets(tmpDir);
		assert.equal(tickets.length, 1);
	});
});

// ════════════════════════════════════════════════════════════════════════
// Type Guards
// ════════════════════════════════════════════════════════════════════════

describe("isError", () => {
	it("returns true for { error: string }", () => {
		assert.equal(isError({ error: "something went wrong" }), true);
	});

	it("returns false for a string", () => {
		assert.equal(isError("hello"), false);
	});

	it("returns false for null", () => {
		assert.equal(isError(null), false);
	});

	it("returns false for a ticket-like object", () => {
		assert.equal(isError(makeFM()), false);
	});

	it("returns false for undefined", () => {
		assert.equal(isError(undefined), false);
	});
});

// ════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════

describe("constants", () => {
	it("VALID_STATUSES has expected values", () => {
		assert.deepEqual(VALID_STATUSES, ["open", "in_progress", "closed"]);
	});

	it("VALID_TYPES has expected values", () => {
		assert.deepEqual(VALID_TYPES, ["bug", "feature", "task", "epic", "chore"]);
	});
});
