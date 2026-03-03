/**
 * kt-core — Pure logic for the kt ticket tracker.
 *
 * Contains all types, parsing, serialization, sorting, query helpers,
 * and file I/O that have no dependency on pi extension APIs. Extracted
 * so that both kt.ts and unit tests can import this module directly.
 */

import crypto from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// ── Constants ──────────────────────────────────────────────────────────

export const TICKETS_DIR = ".tickets";
export const SETTINGS_FILE = "settings.json";
export const LOCK_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_SETTINGS: TicketSettings = { gc: true, gcDays: 7 };

export type TicketStatus = "open" | "in_progress" | "closed";
export type TicketType = "bug" | "feature" | "task" | "epic" | "chore";

export const VALID_STATUSES: TicketStatus[] = ["open", "in_progress", "closed"];
export const VALID_TYPES: TicketType[] = ["bug", "feature", "task", "epic", "chore"];

// ── Types ──────────────────────────────────────────────────────────────

/** JSON frontmatter stored at the top of each ticket file. */
export interface TicketFrontMatter {
	id: string;
	title: string;
	status: TicketStatus;
	type: TicketType;
	priority: number;
	parent?: string;
	deps?: string[];
	links?: string[];
	assignee?: string;
	external_ref?: string;
	tests_passed: boolean;
	created_at: string;
}

/** Full ticket including parsed markdown body sections. */
export interface TicketRecord extends TicketFrontMatter {
	description: string;
	design: string;
	acceptance: string;
	tests: string;
	notes: string;
}

/** Lock file contents. */
export interface LockInfo {
	id: string;
	pid: number;
	session?: string | null;
	created_at: string;
}

/** Settings stored in .tickets/settings.json. */
export interface TicketSettings {
	gc: boolean;
	gcDays: number;
}

/** Parsed markdown body sections of a ticket file. */
export interface BodySections {
	description: string;
	design: string;
	acceptance: string;
	tests: string;
	notes: string;
}

/** Type guard for `{ error: string }` results returned by lock/resolve helpers. */
export function isError(value: unknown): value is { error: string } {
	return typeof value === "object" && value !== null && "error" in value;
}

// ── ID Generation ──────────────────────────────────────────────────────

/** Derive a 2-3 letter prefix from a project directory name. */
export function derivePrefix(dirName: string): string {
	const parts = dirName.split(/[-_]/).filter(Boolean);
	if (parts.length >= 2) {
		return parts.map((p) => p[0]).join("").toLowerCase().slice(0, 3);
	}
	return dirName.slice(0, 2).toLowerCase();
}

/** Get the project prefix for ticket IDs. */
export function getProjectPrefix(cwd: string): string {
	const dirName = path.basename(cwd);
	return derivePrefix(dirName);
}

/** Generate a new unique ticket ID. */
export async function generateId(ticketsDir: string, prefix: string): Promise<string> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const hex = crypto.randomBytes(2).toString("hex");
		const id = `${prefix}-${hex}`;
		if (!existsSync(path.join(ticketsDir, `${id}.md`))) return id;
	}
	throw new Error("Failed to generate unique ticket ID");
}

/** Normalize an ID input: resolve exact or partial matches against the tickets dir. */
export function resolveId(input: string, ticketsDir: string): string | { error: string } {
	const trimmed = input.trim();
	if (!trimmed) return { error: "Ticket ID required" };

	// Check for exact match first
	if (existsSync(path.join(ticketsDir, `${trimmed}.md`))) return trimmed;

	// Try partial match: find files that contain the input
	let entries: string[];
	try {
		entries = readdirSync(ticketsDir).filter((e: string) => e.endsWith(".md"));
	} catch {
		return { error: `Ticket ${trimmed} not found` };
	}

	const matches = entries.filter((e: string) => {
		const id = e.slice(0, -3);
		return id.includes(trimmed) || id.endsWith(trimmed);
	});

	if (matches.length === 1) return matches[0].slice(0, -3);
	if (matches.length > 1) {
		const ids = matches.map((m: string) => m.slice(0, -3)).join(", ");
		return { error: `Ambiguous ID "${trimmed}": matches ${ids}` };
	}

	return { error: `Ticket ${trimmed} not found` };
}

// ── File Format ────────────────────────────────────────────────────────

/** Find the end of a top-level JSON object in a string. */
export function findJsonEnd(content: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < content.length; i += 1) {
		const ch = content[i];
		if (inString) {
			if (escaped) { escaped = false; continue; }
			if (ch === "\\") { escaped = true; continue; }
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') { inString = true; continue; }
		if (ch === "{") { depth += 1; continue; }
		if (ch === "}") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Split file content into JSON frontmatter and markdown body. */
export function splitContent(content: string): { json: string; body: string } {
	if (!content.startsWith("{")) return { json: "", body: content };
	const end = findJsonEnd(content);
	if (end === -1) return { json: "", body: content };
	return {
		json: content.slice(0, end + 1),
		body: content.slice(end + 1).replace(/^\r?\n+/, ""),
	};
}

/** Parse structured markdown body into sections. */
export function parseBody(body: string): BodySections {
	const sections = { description: "", design: "", acceptance: "", tests: "", notes: "" };
	const lines = body.split("\n");
	let current: keyof typeof sections = "description";
	const buf: string[] = [];

	const flush = () => {
		const text = buf.join("\n").trim();
		if (text) sections[current] = text;
		buf.length = 0;
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("## ")) {
			flush();
			const header = trimmed.slice(3).toLowerCase();
			if (header.includes("design")) current = "design";
			else if (header.includes("acceptance")) current = "acceptance";
			else if (header.includes("test")) current = "tests";
			else if (header.includes("note")) current = "notes";
			else { current = "description"; buf.push(line); }
			continue;
		}
		buf.push(line);
	}
	flush();
	return sections;
}

/** Parse a ticket file's content into a TicketRecord. */
export function parseTicket(content: string, idFallback: string): TicketRecord {
	const { json, body } = splitContent(content);
	const fm = parseTicketFrontMatter(json, idFallback);
	const sections = parseBody(body);
	return { ...fm, ...sections };
}

/** Parse JSON frontmatter into TicketFrontMatter. */
export function parseTicketFrontMatter(json: string, idFallback: string): TicketFrontMatter {
	const defaults: TicketFrontMatter = {
		id: idFallback,
		title: "",
		status: "open",
		type: "task",
		priority: 2,
		tests_passed: false,
		created_at: "",
	};

	if (!json.trim()) return defaults;

	try {
		const parsed = JSON.parse(json) as Partial<TicketFrontMatter>;
		return {
			id: typeof parsed.id === "string" ? parsed.id : idFallback,
			title: typeof parsed.title === "string" ? parsed.title : "",
			status: VALID_STATUSES.includes(parsed.status as TicketStatus) ? (parsed.status as TicketStatus) : "open",
			type: VALID_TYPES.includes(parsed.type as TicketType) ? (parsed.type as TicketType) : "task",
			priority: typeof parsed.priority === "number" ? parsed.priority : 2,
			parent: typeof parsed.parent === "string" ? parsed.parent : undefined,
			deps: Array.isArray(parsed.deps) ? parsed.deps.filter((d): d is string => typeof d === "string") : undefined,
			links: Array.isArray(parsed.links) ? parsed.links.filter((l): l is string => typeof l === "string") : undefined,
			assignee: typeof parsed.assignee === "string" ? parsed.assignee : undefined,
			external_ref: typeof parsed.external_ref === "string" ? parsed.external_ref : undefined,
			tests_passed: typeof parsed.tests_passed === "boolean" ? parsed.tests_passed : false,
			created_at: typeof parsed.created_at === "string" ? parsed.created_at : "",
		};
	} catch {
		return defaults;
	}
}

/** Serialize a TicketRecord to file content (JSON frontmatter + markdown). */
export function serializeTicket(ticket: TicketRecord): string {
	const fm: Record<string, unknown> = {
		id: ticket.id,
		title: ticket.title,
		status: ticket.status,
		type: ticket.type,
		priority: ticket.priority,
		tests_passed: ticket.tests_passed,
		created_at: ticket.created_at,
	};
	if (ticket.parent) fm.parent = ticket.parent;
	if (ticket.deps?.length) fm.deps = ticket.deps;
	if (ticket.links?.length) fm.links = ticket.links;
	if (ticket.assignee) fm.assignee = ticket.assignee;
	if (ticket.external_ref) fm.external_ref = ticket.external_ref;

	const json = JSON.stringify(fm, null, 2);
	const parts: string[] = [json, ""];

	if (ticket.description) parts.push(ticket.description, "");
	if (ticket.design) parts.push("## Design", "", ticket.design, "");
	if (ticket.acceptance) parts.push("## Acceptance Criteria", "", ticket.acceptance, "");
	if (ticket.tests) parts.push("## Tests", "", ticket.tests, "");
	if (ticket.notes) parts.push("## Notes", "", ticket.notes, "");

	return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// ── File I/O ───────────────────────────────────────────────────────────

/** Get the tickets directory path for a given cwd. */
export function getTicketsDir(cwd: string): string {
	return path.join(cwd, TICKETS_DIR);
}

/** Get the file path for a ticket by ID. */
export function getTicketPath(dir: string, id: string): string {
	return path.join(dir, `${id}.md`);
}

/** Get the lock file path for a ticket by ID. */
export function getLockPath(dir: string, id: string): string {
	return path.join(dir, `${id}.lock`);
}

/** Create the tickets directory if it doesn't exist. */
export async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
}

/** Read and parse a ticket file. */
export async function readTicketFile(filePath: string, id: string): Promise<TicketRecord> {
	const content = await fs.readFile(filePath, "utf8");
	return parseTicket(content, id);
}

/** Write a ticket to a file. */
export async function writeTicketFile(filePath: string, ticket: TicketRecord): Promise<void> {
	await fs.writeFile(filePath, serializeTicket(ticket), "utf8");
}

// ── Settings & GC ──────────────────────────────────────────────────────

/** Read settings from settings.json, returning defaults on any error. */
export async function readSettings(dir: string): Promise<TicketSettings> {
	try {
		const raw = JSON.parse(await fs.readFile(path.join(dir, SETTINGS_FILE), "utf8")) as Partial<TicketSettings>;
		return {
			gc: raw.gc ?? DEFAULT_SETTINGS.gc,
			gcDays: typeof raw.gcDays === "number" ? Math.max(0, raw.gcDays) : DEFAULT_SETTINGS.gcDays,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

/** Delete closed tickets older than the GC threshold. */
export async function garbageCollect(dir: string, settings: TicketSettings): Promise<void> {
	if (!settings.gc) return;
	let entries: string[];
	try { entries = await fs.readdir(dir); } catch { return; }

	const cutoff = Date.now() - settings.gcDays * 24 * 60 * 60 * 1000;
	await Promise.all(
		entries.filter((e) => e.endsWith(".md")).map(async (e) => {
			try {
				const content = await fs.readFile(path.join(dir, e), "utf8");
				const { json } = splitContent(content);
				const fm = parseTicketFrontMatter(json, e.slice(0, -3));
				if (fm.status !== "closed") return;
				const created = Date.parse(fm.created_at);
				if (Number.isFinite(created) && created < cutoff) {
					await fs.unlink(path.join(dir, e));
				}
			} catch { /* ignore */ }
		}),
	);
}

// ── Ticket Queries ─────────────────────────────────────────────────────

/** List all tickets in the directory (async). */
export async function listTickets(dir: string): Promise<TicketFrontMatter[]> {
	let entries: string[];
	try { entries = await fs.readdir(dir); } catch { return []; }

	const tickets: TicketFrontMatter[] = [];
	for (const e of entries) {
		if (!e.endsWith(".md")) continue;
		try {
			const content = await fs.readFile(path.join(dir, e), "utf8");
			const { json } = splitContent(content);
			tickets.push(parseTicketFrontMatter(json, e.slice(0, -3)));
		} catch { /* ignore */ }
	}
	return sortTickets(tickets);
}

/** List all tickets in the directory (sync). */
export function listTicketsSync(dir: string): TicketFrontMatter[] {
	let entries: string[];
	try { entries = readdirSync(dir); } catch { return []; }

	const tickets: TicketFrontMatter[] = [];
	for (const e of entries) {
		if (!e.endsWith(".md")) continue;
		try {
			const content = readFileSync(path.join(dir, e), "utf8");
			const { json } = splitContent(content);
			tickets.push(parseTicketFrontMatter(json, e.slice(0, -3)));
		} catch { /* ignore */ }
	}
	return sortTickets(tickets);
}

const STATUS_ORDER: Record<TicketStatus, number> = { in_progress: 0, open: 1, closed: 2 };

/** Sort tickets: in_progress first, then open by priority, closed last. */
export function sortTickets(tickets: TicketFrontMatter[]): TicketFrontMatter[] {
	return [...tickets].sort((a, b) =>
		(STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
		|| (a.priority - b.priority)
		|| (a.created_at || "").localeCompare(b.created_at || ""),
	);
}

/** Get tickets that are ready to work on (not closed, all deps resolved). */
export function getReadyTickets(tickets: TicketFrontMatter[]): TicketFrontMatter[] {
	const closedIds = new Set(tickets.filter((t) => t.status === "closed").map((t) => t.id));
	return tickets.filter((t) => {
		if (t.status === "closed") return false;
		if (!t.deps?.length) return true;
		return t.deps.every((dep) => closedIds.has(dep));
	});
}

// ── Formatting ─────────────────────────────────────────────────────────

/** Get the status icon character for a ticket status. */
export function statusIcon(status: TicketStatus): string {
	switch (status) {
		case "open": return "○";
		case "in_progress": return "●";
		case "closed": return "✓";
	}
}

/** Format a single ticket as a plain-text line. */
export function formatTicketLine(t: TicketFrontMatter): string {
	const tags = [t.type, `p${t.priority}`];
	if (t.parent) tags.push(`↑${t.parent}`);
	if (t.assignee) tags.push(`@${t.assignee}`);
	return `${statusIcon(t.status)} ${t.id} ${t.title || "(untitled)"} [${tags.join(", ")}]`;
}

/** Serialize a ticket record as JSON for the agent's response. */
export function serializeForAgent(ticket: TicketRecord): string {
	return JSON.stringify(ticket, null, 2);
}

/** Serialize a ticket list as grouped JSON for the agent's response. */
export function serializeListForAgent(tickets: TicketFrontMatter[]): string {
	const open = tickets.filter((t) => t.status === "open");
	const inProgress = tickets.filter((t) => t.status === "in_progress");
	const closed = tickets.filter((t) => t.status === "closed");
	return JSON.stringify({ in_progress: inProgress, open, closed }, null, 2);
}

// ── Search ─────────────────────────────────────────────────────────────

/** Build a searchable text string from a ticket's fields. */
export function buildSearchText(t: TicketFrontMatter): string {
	const parts = [t.id, t.title, t.type, t.status, `p${t.priority}`];
	if (t.parent) parts.push(t.parent);
	if (t.assignee) parts.push(t.assignee);
	return parts.join(" ");
}

/** Filter tickets by a query string (case-insensitive substring matching per token). */
export function filterTickets(tickets: TicketFrontMatter[], query: string): TicketFrontMatter[] {
	const trimmed = query.trim();
	if (!trimmed) return tickets;
	const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
	if (!tokens.length) return tickets;

	return tickets.filter((t) => {
		const text = buildSearchText(t).toLowerCase();
		return tokens.every((token) => text.includes(token));
	});
}

// ── Prompt helpers ─────────────────────────────────────────────────────

/** Build the prompt text for working on a ticket. */
export function buildWorkPrompt(ticket: TicketFrontMatter): string {
	return `work on ticket ${ticket.id} "${ticket.title || "(untitled)"}"`;
}

/** Build the prompt text for refining a ticket's description. */
export function buildRefinePrompt(ticket: TicketFrontMatter): string {
	return (
		`let's refine ticket ${ticket.id} "${ticket.title || "(untitled)"}": ` +
		"Ask me for the missing details needed to refine the ticket together. Do not rewrite the ticket yet and do not make assumptions. " +
		"Ask clear, concrete questions and wait for my answers before drafting any structured description.\n\n"
	);
}
