/**
 * kt — Git-Backed Ticket Tracker
 *
 * A full-featured ticket tracker for AI agents, inspired by kticket.
 * Stores tickets as markdown files with JSON frontmatter in `.tickets/`.
 * Supports hierarchy (parent/child), dependencies, types, priorities,
 * status workflow, test validation, and session assignment.
 *
 * Provides:
 * - `kt` tool with 9 actions (create, show, update, delete, start, close, reopen, list, add-note)
 * - `/kt` TUI browser with fuzzy search and action menu
 * - `/kt-create` prompt injection for epic + task breakdown
 * - `/kt-run-all` automated ticket processing loop with session forking
 * - Widget showing current in-progress ticket
 * - Status line with ticket counts
 * - Auto-nudge on agent_end when tickets remain in-progress
 */

import {
	DynamicBorder,
	copyToClipboard,
	getMarkdownTheme,
	keyHint,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ThemeColor,
} from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
	Container,
	type Focusable,
	type SelectItem,
	Input,
	Key,
	Markdown,
	SelectList,
	Spacer,
	Text,
	TUI,
	getEditorKeybindings,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import {
	type LockInfo,
	type TicketFrontMatter,
	type TicketRecord,
	type TicketStatus,
	type TicketType,
	LOCK_TTL_MS,
	VALID_STATUSES,
	VALID_TYPES,
	buildRefinePrompt,
	buildWorkPrompt,
	ensureDir,
	filterTickets,
	formatTicketLine,
	garbageCollect,
	generateId,
	getLockPath,
	getProjectPrefix,
	getReadyTickets,
	getTicketPath,
	getTicketsDir,
	isError,
	listTickets,
	listTicketsSync,
	readSettings,
	readTicketFile,
	resolveId,
	serializeForAgent,
	serializeListForAgent,
	statusIcon,
	writeTicketFile,
} from "./kt-core.ts";

/** Tool result details for renderResult. */
type KtToolDetails =
	| { action: "list"; tickets: TicketFrontMatter[]; currentSessionId?: string }
	| { action: string; ticket: TicketRecord; error?: string }
	| { action: string; error: string };

type KtMenuAction = "view" | "work" | "refine" | "close" | "reopen" | "delete" | "copyPath" | "copyText";
type KtOverlayAction = "back" | "work";

// ── Tool parameters ────────────────────────────────────────────────────

const KtParams = Type.Object({
	action: StringEnum([
		"create", "show", "update", "delete",
		"start", "close", "reopen",
		"list", "add-note",
	] as const),
	id: Type.Optional(Type.String({ description: "Ticket ID (full or partial, e.g. as-a1b2 or just a1b2)" })),
	title: Type.Optional(Type.String({ description: "Ticket title" })),
	description: Type.Optional(Type.String({ description: "Ticket description" })),
	type: Type.Optional(StringEnum(VALID_TYPES)),
	priority: Type.Optional(Type.Number({ description: "Priority 0-4 (0=highest, default 2)" })),
	parent: Type.Optional(Type.String({ description: "Parent ticket ID" })),
	deps: Type.Optional(Type.Array(Type.String(), { description: "Dependency ticket IDs" })),
	external_ref: Type.Optional(Type.String({ description: "External reference (e.g. gh-42)" })),
	design: Type.Optional(Type.String({ description: "Design notes" })),
	acceptance: Type.Optional(Type.String({ description: "Acceptance criteria" })),
	tests: Type.Optional(Type.String({ description: "Test requirements" })),
	text: Type.Optional(Type.String({ description: "Note text (for add-note)" })),
	status: Type.Optional(StringEnum(VALID_STATUSES)),
	tests_confirmed: Type.Optional(Type.Boolean({ description: "Confirm tests pass when closing a ticket with test requirements" })),
});

// ── Locking (requires ExtensionContext, stays in kt.ts) ────────────────

async function acquireLock(
	dir: string,
	id: string,
	ctx: ExtensionContext,
): Promise<(() => Promise<void>) | { error: string }> {
	const lp = getLockPath(dir, id);
	const session = ctx.sessionManager.getSessionFile();

	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await fs.open(lp, "wx");
			const info: LockInfo = { id, pid: process.pid, session, created_at: new Date().toISOString() };
			await handle.writeFile(JSON.stringify(info, null, 2), "utf8");
			await handle.close();
			return async () => { try { await fs.unlink(lp); } catch { /* ignore */ } };
		} catch (err: any) {
			if (err?.code !== "EEXIST") return { error: `Lock failed: ${err?.message ?? "unknown"}` };

			const stats = await fs.stat(lp).catch(() => null);
			if (stats && Date.now() - stats.mtimeMs <= LOCK_TTL_MS) {
				let lockInfo: LockInfo | null = null;
				try { lockInfo = JSON.parse(await fs.readFile(lp, "utf8")) as LockInfo; } catch { /* ignore */ }
				const owner = lockInfo?.session ? ` (session ${lockInfo.session})` : "";
				return { error: `Ticket ${id} is locked${owner}. Try again later.` };
			}

			// Stale lock
			if (!ctx.hasUI) return { error: `Ticket ${id} lock is stale; rerun in interactive mode.` };
			const ok = await ctx.ui.confirm("Ticket locked", `Ticket ${id} appears locked. Steal the lock?`);
			if (!ok) return { error: `Ticket ${id} remains locked.` };
			await fs.unlink(lp).catch(() => undefined);
		}
	}
	return { error: `Failed to acquire lock for ${id}.` };
}

async function withLock<T>(
	dir: string,
	id: string,
	ctx: ExtensionContext,
	fn: () => Promise<T>,
): Promise<T | { error: string }> {
	const lock = await acquireLock(dir, id, ctx);
	if (isError(lock)) return lock;
	try { return await fn(); }
	finally { await lock(); }
}

// ── Themed Rendering ───────────────────────────────────────────────────

const STATUS_COLORS: Record<TicketStatus, { icon: ThemeColor; title: ThemeColor }> = {
	closed: { icon: "dim", title: "dim" },
	in_progress: { icon: "accent", title: "success" },
	open: { icon: "muted", title: "text" },
};

function renderTicketHeading(theme: Theme, t: TicketFrontMatter, currentSession?: string): string {
	const { icon: iconColor, title: titleColor } = STATUS_COLORS[t.status];

	const icon = theme.fg(iconColor, statusIcon(t.status));
	const meta = [theme.fg("muted", t.type), theme.fg("muted", `p${t.priority}`)];
	if (t.parent) meta.push(theme.fg("dim", `↑${t.parent}`));
	if (t.assignee) {
		const isCurrent = t.assignee === currentSession;
		meta.push(theme.fg(isCurrent ? "success" : "dim", `@${isCurrent ? "me" : t.assignee}`));
	}
	return `${icon} ${theme.fg("accent", t.id)} ${theme.fg(titleColor, t.title || "(untitled)")} ${theme.fg("muted", `[${meta.join(", ")}]`)}`;
}

function renderTicketList(theme: Theme, tickets: TicketFrontMatter[], expanded: boolean, currentSession?: string): string {
	if (!tickets.length) return theme.fg("dim", "No tickets");

	const inProgress = tickets.filter((t) => t.status === "in_progress");
	const open = tickets.filter((t) => t.status === "open");
	const closed = tickets.filter((t) => t.status === "closed");
	const lines: string[] = [];

	const pushSection = (label: string, items: TicketFrontMatter[], maxItems: number) => {
		lines.push(theme.fg("muted", `${label} (${items.length})`));
		if (!items.length) { lines.push(theme.fg("dim", "  none")); return; }
		const show = expanded ? items : items.slice(0, maxItems);
		for (const t of show) lines.push(`  ${renderTicketHeading(theme, t, currentSession)}`);
		if (!expanded && items.length > maxItems) lines.push(theme.fg("dim", `  ... ${items.length - maxItems} more`));
	};

	pushSection("In Progress", inProgress, 5);
	lines.push("");
	pushSection("Open", open, 5);
	lines.push("");
	pushSection("Closed", closed, 3);

	return lines.join("\n");
}

/** Build the standard SelectList styling using the current theme. */
function selectListStyle(theme: Theme) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

// ── TUI Components ─────────────────────────────────────────────────────

class TicketSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private listContainer: Container;
	private allTickets: TicketFrontMatter[];
	private filteredTickets: TicketFrontMatter[];
	private selectedIndex = 0;
	private onSelectCallback: (ticket: TicketFrontMatter) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private theme: Theme;
	private headerText: Text;
	private hintText: Text;
	private currentSession?: string;
	private onQuickAction?: (ticket: TicketFrontMatter, action: "work" | "refine") => void;

	private _focused = false;
	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.searchInput.focused = value; }

	constructor(
		tui: TUI,
		theme: Theme,
		tickets: TicketFrontMatter[],
		onSelect: (ticket: TicketFrontMatter) => void,
		onCancel: () => void,
		initialSearch?: string,
		currentSession?: string,
		onQuickAction?: (ticket: TicketFrontMatter, action: "work" | "refine") => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.allTickets = tickets;
		this.filteredTickets = tickets;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.currentSession = currentSession;
		this.onQuickAction = onQuickAction;

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));

		this.headerText = new Text("", 1, 0);
		this.addChild(this.headerText);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (initialSearch) this.searchInput.setValue(initialSearch);
		this.searchInput.onSubmit = () => {
			const sel = this.filteredTickets[this.selectedIndex];
			if (sel) this.onSelectCallback(sel);
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));

		this.hintText = new Text("", 1, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		this.updateHeader();
		this.updateHints();
		this.applyFilter(this.searchInput.getValue());
	}

	setTickets(tickets: TicketFrontMatter[]): void {
		this.allTickets = tickets;
		this.updateHeader();
		this.applyFilter(this.searchInput.getValue());
		this.tui.requestRender();
	}

	getSearchValue(): string { return this.searchInput.getValue(); }

	private updateHeader(): void {
		const open = this.allTickets.filter((t) => t.status !== "closed").length;
		const closed = this.allTickets.length - open;
		this.headerText.setText(this.theme.fg("accent", this.theme.bold(`Tickets (${open} open, ${closed} closed)`)));
	}

	private updateHints(): void {
		this.hintText.setText(this.theme.fg("dim", "Type to search • ↑↓ select • Enter actions • Ctrl+Shift+W work • Ctrl+Shift+R refine • Esc close"));
	}

	private applyFilter(query: string): void {
		this.filteredTickets = filterTickets(this.allTickets, query);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredTickets.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		if (!this.filteredTickets.length) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching tickets"), 0, 0));
			return;
		}

		const maxVisible = 10;
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredTickets.length - maxVisible));
		const end = Math.min(start + maxVisible, this.filteredTickets.length);

		for (let i = start; i < end; i += 1) {
			const t = this.filteredTickets[i];
			if (!t) continue;
			const selected = i === this.selectedIndex;
			const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
			this.listContainer.addChild(new Text(prefix + renderTicketHeading(this.theme, t, this.currentSession), 0, 0));
		}

		if (start > 0 || end < this.filteredTickets.length) {
			this.listContainer.addChild(new Text(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.filteredTickets.length})`), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();
		if (kb.matches(keyData, "selectUp")) {
			if (!this.filteredTickets.length) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredTickets.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "selectDown")) {
			if (!this.filteredTickets.length) return;
			this.selectedIndex = this.selectedIndex === this.filteredTickets.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "selectConfirm")) {
			const sel = this.filteredTickets[this.selectedIndex];
			if (sel) this.onSelectCallback(sel);
			return;
		}
		if (kb.matches(keyData, "selectCancel")) {
			this.onCancelCallback();
			return;
		}
		if (matchesKey(keyData, Key.ctrlShift("r"))) {
			const sel = this.filteredTickets[this.selectedIndex];
			if (sel && this.onQuickAction) this.onQuickAction(sel, "refine");
			return;
		}
		if (matchesKey(keyData, Key.ctrlShift("w"))) {
			const sel = this.filteredTickets[this.selectedIndex];
			if (sel && this.onQuickAction) this.onQuickAction(sel, "work");
			return;
		}
		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}

	override invalidate(): void {
		super.invalidate();
		this.updateHeader();
		this.updateHints();
		this.updateList();
	}
}

class TicketActionMenuComponent extends Container {
	private selectList: SelectList;

	constructor(
		theme: Theme,
		ticket: TicketRecord,
		onSelect: (action: KtMenuAction) => void,
		onCancel: () => void,
	) {
		super();
		const closed = ticket.status === "closed";
		const options: SelectItem[] = [
			{ value: "view", label: "view", description: "View ticket details" },
			{ value: "work", label: "work", description: "Work on this ticket" },
			{ value: "refine", label: "refine", description: "Refine ticket description" },
			...(closed
				? [{ value: "reopen", label: "reopen", description: "Reopen ticket" }]
				: [{ value: "close", label: "close", description: "Close ticket" }]),
			{ value: "copyPath", label: "copy path", description: "Copy file path" },
			{ value: "copyText", label: "copy text", description: "Copy ticket text" },
			{ value: "delete", label: "delete", description: "Delete ticket" },
		];

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Text(theme.fg("accent", theme.bold(`Actions for ${ticket.id} "${ticket.title || "(untitled)"}"`)), 1, 0));

		this.selectList = new SelectList(options, options.length, selectListStyle(theme));
		this.selectList.onSelect = (item) => onSelect(item.value as KtMenuAction);
		this.selectList.onCancel = () => onCancel();

		this.addChild(this.selectList);
		this.addChild(new Text(theme.fg("dim", "Enter to confirm • Esc back")));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	}

	handleInput(keyData: string): void {
		this.selectList.handleInput(keyData);
	}
}

class TicketDeleteConfirmComponent extends Container {
	private selectList: SelectList;

	constructor(theme: Theme, message: string, onConfirm: (confirmed: boolean) => void) {
		super();
		const options: SelectItem[] = [
			{ value: "yes", label: "Yes" },
			{ value: "no", label: "No" },
		];

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Text(theme.fg("accent", message)));

		this.selectList = new SelectList(options, options.length, selectListStyle(theme));
		this.selectList.onSelect = (item) => onConfirm(item.value === "yes");
		this.selectList.onCancel = () => onConfirm(false);

		this.addChild(this.selectList);
		this.addChild(new Text(theme.fg("dim", "Enter to confirm • Esc back")));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	}

	handleInput(keyData: string): void {
		this.selectList.handleInput(keyData);
	}
}

class TicketDetailOverlayComponent {
	private ticket: TicketRecord;
	private theme: Theme;
	private tui: TUI;
	private markdown: Markdown;
	private scrollOffset = 0;
	private viewHeight = 0;
	private totalLines = 0;
	private onAction: (action: KtOverlayAction) => void;

	constructor(tui: TUI, theme: Theme, ticket: TicketRecord, onAction: (action: KtOverlayAction) => void) {
		this.tui = tui;
		this.theme = theme;
		this.ticket = ticket;
		this.onAction = onAction;
		this.markdown = new Markdown(this.getMarkdownText(), 1, 0, getMarkdownTheme());
	}

	private getMarkdownText(): string {
		const parts: string[] = [];
		if (this.ticket.description) parts.push(this.ticket.description);
		if (this.ticket.design) parts.push("## Design\n\n" + this.ticket.design);
		if (this.ticket.acceptance) parts.push("## Acceptance Criteria\n\n" + this.ticket.acceptance);
		if (this.ticket.tests) parts.push("## Tests\n\n" + this.ticket.tests);
		if (this.ticket.notes) parts.push("## Notes\n\n" + this.ticket.notes);
		return parts.join("\n\n") || "_No details yet._";
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();
		if (kb.matches(keyData, "selectCancel")) { this.onAction("back"); return; }
		if (kb.matches(keyData, "selectConfirm")) { this.onAction("work"); return; }
		if (kb.matches(keyData, "selectUp")) { this.scrollBy(-1); return; }
		if (kb.matches(keyData, "selectDown")) { this.scrollBy(1); return; }
		if (kb.matches(keyData, "selectPageUp")) { this.scrollBy(-(this.viewHeight || 1)); return; }
		if (kb.matches(keyData, "selectPageDown")) { this.scrollBy(this.viewHeight || 1); return; }
	}

	render(width: number): string[] {
		const maxHeight = Math.max(10, Math.floor((this.tui.terminal.rows || 24) * 0.8));
		const innerWidth = Math.max(10, width - 2);
		const headerLines = 3;
		const footerLines = 3;
		const contentHeight = Math.max(1, maxHeight - headerLines - footerLines - 2);

		const markdownLines = this.markdown.render(innerWidth);
		this.totalLines = markdownLines.length;
		this.viewHeight = contentHeight;
		const maxScroll = Math.max(0, this.totalLines - contentHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

		const visible = markdownLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		const lines: string[] = [];

		// Title line
		const titleText = ` ${this.ticket.title || this.ticket.id} `;
		const titleW = visibleWidth(titleText);
		const leftW = Math.max(0, Math.floor((innerWidth - titleW) / 2));
		const rightW = Math.max(0, innerWidth - titleW - leftW);
		lines.push(
			this.theme.fg("borderMuted", "─".repeat(leftW)) +
			this.theme.fg("accent", titleText) +
			this.theme.fg("borderMuted", "─".repeat(rightW))
		);

		// Meta line
		const statusColor = this.ticket.status === "closed" ? "dim" : "success";
		lines.push(
			this.theme.fg("accent", this.ticket.id) +
			this.theme.fg("muted", " • ") +
			this.theme.fg(statusColor, this.ticket.status) +
			this.theme.fg("muted", ` • ${this.ticket.type} • p${this.ticket.priority}`)
		);
		lines.push("");

		for (const line of visible) lines.push(truncateToWidth(line, innerWidth));
		while (lines.length < headerLines + contentHeight) lines.push("");

		lines.push("");
		let actionLine = this.theme.fg("accent", "enter") + this.theme.fg("muted", " work") +
			this.theme.fg("muted", " • ") + this.theme.fg("dim", "esc back");
		if (this.totalLines > this.viewHeight) {
			const s = Math.min(this.totalLines, this.scrollOffset + 1);
			const e = Math.min(this.totalLines, this.scrollOffset + this.viewHeight);
			actionLine += this.theme.fg("dim", ` ${s}-${e}/${this.totalLines}`);
		}
		lines.push(actionLine);

		const border = (text: string) => this.theme.fg("borderMuted", text);
		const top = border(`┌${"─".repeat(innerWidth)}┐`);
		const bottom = border(`└${"─".repeat(innerWidth)}┘`);
		const framed = lines.map((l) => {
			const t = truncateToWidth(l, innerWidth);
			const pad = Math.max(0, innerWidth - visibleWidth(t));
			return border("│") + t + " ".repeat(pad) + border("│");
		});
		return [top, ...framed, bottom].map((l) => truncateToWidth(l, width));
	}

	invalidate(): void {
		this.markdown = new Markdown(this.getMarkdownText(), 1, 0, getMarkdownTheme());
	}

	private scrollBy(delta: number): void {
		const max = Math.max(0, this.totalLines - this.viewHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, max));
	}
}

// ── Extension ──────────────────────────────────────────────────────────

export default function ktExtension(pi: ExtensionAPI) {
	let nudgedThisCycle = false;

	// ── Session events ─────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const dir = getTicketsDir(ctx.cwd);
		await ensureDir(dir);
		const settings = await readSettings(dir);
		await garbageCollect(dir, settings);
		refreshUI(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => refreshUI(ctx));
	pi.on("session_fork", async (_event, ctx) => refreshUI(ctx));
	pi.on("session_tree", async (_event, ctx) => refreshUI(ctx));

	// ── Auto-nudge ─────────────────────────────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		const dir = getTicketsDir(ctx.cwd);
		const tickets = await listTickets(dir);
		const inProgress = tickets.filter((t) => t.status === "in_progress");
		if (!inProgress.length || nudgedThisCycle) return;

		nudgedThisCycle = true;
		const list = inProgress.map((t) => `  ${statusIcon(t.status)} ${t.id}: ${t.title}`).join("\n");
		pi.sendMessage({
			customType: "kt-nudge",
			content: `⚠️ You still have ${inProgress.length} in-progress ticket(s):\n\n${list}\n\nContinue working on them or close them when done.`,
			display: true,
		}, { triggerTurn: true });
	});

	pi.on("input", async () => {
		nudgedThisCycle = false;
		return { action: "continue" as const };
	});

	// ── UI refresh ─────────────────────────────────────────────────────

	function refreshUI(ctx: ExtensionContext): void {
		const dir = getTicketsDir(ctx.cwd);
		const tickets = listTicketsSync(dir);
		const inProgress = tickets.filter((t) => t.status === "in_progress");
		const remaining = tickets.filter((t) => t.status !== "closed").length;

		// Status
		if (!tickets.length) {
			ctx.ui.setStatus("🎫 kt: no tickets", "kt");
		} else {
			ctx.ui.setStatus(`🎫 kt: ${tickets.length} tickets (${remaining} remaining)`, "kt");
		}

		// Widget: current in-progress ticket
		if (inProgress.length) {
			ctx.ui.setWidget("kt-current", (_tui, theme) => {
				const container = new Container();
				container.addChild(new Text("", 0, 0));
				container.addChild(new DynamicBorder((s: string) => theme.fg("dim", s)));
				const content = new Text("", 1, 0);
				container.addChild(content);
				container.addChild(new DynamicBorder((s: string) => theme.fg("dim", s)));

				return {
					render(width: number) {
						const cur = inProgress[0];
						if (!cur) return [];
						const line = theme.fg("accent", "● ") +
							theme.fg("dim", "WORKING ON  ") +
							theme.fg("accent", cur.id) +
							theme.fg("dim", "  ") +
							theme.fg("success", cur.title || "(untitled)");
						content.setText(truncateToWidth(line, width - 4));
						return container.render(width);
					},
					invalidate() { container.invalidate(); },
				};
			}, { placement: "belowEditor" });
		} else {
			ctx.ui.setWidget("kt-current", undefined);
		}
	}

	// ── Tool result helpers ─────────────────────────────────────────────

	/** Build a tool error result. */
	function errorResult(action: string, message: string) {
		return {
			content: [{ type: "text" as const, text: message }],
			details: { action, error: message },
		};
	}

	/** Build a tool success result containing a ticket. */
	function ticketResult(action: string, ticket: TicketRecord) {
		return {
			content: [{ type: "text" as const, text: serializeForAgent(ticket) }],
			details: { action, ticket },
		};
	}

	/** Validate and resolve a ticket ID param, returning an error result or the resolved ID string. */
	function requireId(action: string, id: string | undefined, dir: string): string | ReturnType<typeof errorResult> {
		if (!id) return errorResult(action, "Error: id required");
		const resolved = resolveId(id, dir);
		if (isError(resolved)) return errorResult(action, resolved.error);
		return resolved;
	}

	// ── kt tool ────────────────────────────────────────────────────────

	pi.registerTool({
		name: "kt",
		label: "kt",
		description:
			"Git-backed ticket tracker. Actions: create, show, update, delete, start, close, reopen, list, add-note. " +
			"Tickets stored in .tickets/ as markdown files. IDs use project prefix (e.g. as-a1b2). Partial ID matching supported. " +
			"Use start to begin working on a ticket (sets in_progress). Use close when done. " +
			"If a ticket has test requirements, you must verify tests pass and set tests_confirmed=true when closing.",
		parameters: KtParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const dir = getTicketsDir(ctx.cwd);
			const prefix = getProjectPrefix(ctx.cwd);

			switch (params.action) {
				// ── create ──────────────────────────────────────────────
				case "create": {
					if (!params.title) return errorResult("create", "Error: title required");

					await ensureDir(dir);
					const id = await generateId(dir, prefix);
					const ticket: TicketRecord = {
						id,
						title: params.title,
						status: (params.status as TicketStatus) ?? "open",
						type: (params.type as TicketType) ?? "task",
						priority: params.priority ?? 2,
						parent: params.parent,
						deps: params.deps,
						external_ref: params.external_ref,
						tests_passed: false,
						created_at: new Date().toISOString(),
						description: params.description ?? "",
						design: params.design ?? "",
						acceptance: params.acceptance ?? "",
						tests: params.tests ?? "",
						notes: "",
					};

					const result = await withLock(dir, id, ctx, async () => {
						await writeTicketFile(getTicketPath(dir, id), ticket);
						return ticket;
					});
					if (isError(result)) return errorResult("create", result.error);

					refreshUI(ctx);
					return ticketResult("create", ticket);
				}

				// ── show ───────────────────────────────────────────────
				case "show": {
					const resolved = requireId("show", params.id, dir);
					if (typeof resolved !== "string") return resolved;

					const ticket = await readTicketFile(getTicketPath(dir, resolved), resolved);
					return ticketResult("show", ticket);
				}

				// ── update ─────────────────────────────────────────────
				case "update": {
					const resolved = requireId("update", params.id, dir);
					if (typeof resolved !== "string") return resolved;

					const result = await withLock(dir, resolved, ctx, async () => {
						const fp = getTicketPath(dir, resolved);
						if (!existsSync(fp)) return { error: `Ticket ${resolved} not found` } as const;
						const existing = await readTicketFile(fp, resolved);

						if (params.title !== undefined) existing.title = params.title;
						if (params.status !== undefined) existing.status = params.status as TicketStatus;
						if (params.type !== undefined) existing.type = params.type as TicketType;
						if (params.priority !== undefined) existing.priority = params.priority;
						if (params.parent !== undefined) existing.parent = params.parent;
						if (params.deps !== undefined) existing.deps = params.deps;
						if (params.external_ref !== undefined) existing.external_ref = params.external_ref;
						if (params.description !== undefined) existing.description = params.description;
						if (params.design !== undefined) existing.design = params.design;
						if (params.acceptance !== undefined) existing.acceptance = params.acceptance;
						if (params.tests !== undefined) existing.tests = params.tests;
						if (existing.status === "closed") existing.assignee = undefined;

						await writeTicketFile(fp, existing);
						return existing;
					});
					if (isError(result)) return errorResult("update", result.error);

					refreshUI(ctx);
					return ticketResult("update", result as TicketRecord);
				}

				// ── delete ─────────────────────────────────────────────
				case "delete": {
					const resolved = requireId("delete", params.id, dir);
					if (typeof resolved !== "string") return resolved;

					const result = await withLock(dir, resolved, ctx, async () => {
						const fp = getTicketPath(dir, resolved);
						if (!existsSync(fp)) return { error: `Ticket ${resolved} not found` } as const;
						const ticket = await readTicketFile(fp, resolved);
						await fs.unlink(fp);
						return ticket;
					});
					if (isError(result)) return errorResult("delete", result.error);

					refreshUI(ctx);
					return ticketResult("delete", result as TicketRecord);
				}

				// ── start ──────────────────────────────────────────────
				case "start": {
					const resolved = requireId("start", params.id, dir);
					if (typeof resolved !== "string") return resolved;

					const sessionId = ctx.sessionManager.getSessionId();
					const result = await withLock(dir, resolved, ctx, async () => {
						const fp = getTicketPath(dir, resolved);
						if (!existsSync(fp)) return { error: `Ticket ${resolved} not found` } as const;
						const ticket = await readTicketFile(fp, resolved);
						if (ticket.status === "closed") return { error: `Ticket ${resolved} is closed. Reopen first.` } as const;
						ticket.status = "in_progress";
						ticket.assignee = sessionId;
						await writeTicketFile(fp, ticket);
						return ticket;
					});
					if (isError(result)) return errorResult("start", result.error);

					// Pin session name to ticket
					const ticket = result as TicketRecord;
					const sessionName = `${ticket.id}: ${ticket.title || "(untitled)"}`;
					pi.setSessionName(sessionName);
					pi.appendEntry("session-name-pin", { name: sessionName });

					refreshUI(ctx);
					return ticketResult("start", ticket);
				}

				// ── close ──────────────────────────────────────────────
				case "close": {
					const resolved = requireId("close", params.id, dir);
					if (typeof resolved !== "string") return resolved;

					const result = await withLock(dir, resolved, ctx, async () => {
						const fp = getTicketPath(dir, resolved);
						if (!existsSync(fp)) return { error: `Ticket ${resolved} not found` } as const;
						const ticket = await readTicketFile(fp, resolved);

						// Test validation: block with criteria if tests exist and aren't confirmed
						if (ticket.tests.trim() && !ticket.tests_passed && !params.tests_confirmed) {
							return {
								error: `Cannot close ${resolved}: this ticket has test requirements that must pass first.\n\n## Tests\n${ticket.tests.trim()}\n\nVerify these tests pass, then call \`kt close\` again with tests_confirmed=true.`,
							} as const;
						}

						if (ticket.tests.trim() && params.tests_confirmed) {
							ticket.tests_passed = true;
						}

						ticket.status = "closed";
						ticket.assignee = undefined;
						await writeTicketFile(fp, ticket);
						return ticket;
					});
					if (isError(result)) return errorResult("close", result.error);

					refreshUI(ctx);
					return ticketResult("close", result as TicketRecord);
				}

				// ── reopen ─────────────────────────────────────────────
				case "reopen": {
					const resolved = requireId("reopen", params.id, dir);
					if (typeof resolved !== "string") return resolved;

					const result = await withLock(dir, resolved, ctx, async () => {
						const fp = getTicketPath(dir, resolved);
						if (!existsSync(fp)) return { error: `Ticket ${resolved} not found` } as const;
						const ticket = await readTicketFile(fp, resolved);
						ticket.status = "open";
						ticket.tests_passed = false;
						await writeTicketFile(fp, ticket);
						return ticket;
					});
					if (isError(result)) return errorResult("reopen", result.error);

					refreshUI(ctx);
					return ticketResult("reopen", result as TicketRecord);
				}

				// ── list ───────────────────────────────────────────────
				case "list": {
					const tickets = await listTickets(dir);
					const filtered = params.status
						? tickets.filter((t) => t.status === params.status)
						: tickets.filter((t) => t.status !== "closed");
					const currentSession = ctx.sessionManager.getSessionId();
					return {
						content: [{ type: "text", text: serializeListForAgent(filtered) }],
						details: { action: "list", tickets: filtered, currentSessionId: currentSession },
					};
				}

				// ── add-note ───────────────────────────────────────────
				case "add-note": {
					if (!params.text?.trim()) return errorResult("add-note", "Error: text required");
					const resolved = requireId("add-note", params.id, dir);
					if (typeof resolved !== "string") return resolved;

					const result = await withLock(dir, resolved, ctx, async () => {
						const fp = getTicketPath(dir, resolved);
						if (!existsSync(fp)) return { error: `Ticket ${resolved} not found` } as const;
						const ticket = await readTicketFile(fp, resolved);
						const timestamp = new Date().toISOString();
						const note = `**${timestamp}**\n${params.text!.trim()}`;
						ticket.notes = ticket.notes.trim() ? `${ticket.notes.trim()}\n\n${note}` : note;
						await writeTicketFile(fp, ticket);
						return ticket;
					});
					if (isError(result)) return errorResult("add-note", result.error);

					return ticketResult("add-note", result as TicketRecord);
				}

				default:
					return errorResult(params.action, `Unknown action: ${params.action}`);
			}
		},

		renderCall(args, theme) {
			const action = typeof args.action === "string" ? args.action : "";
			const id = typeof args.id === "string" ? args.id : "";
			const title = typeof args.title === "string" ? args.title : "";
			let text = theme.fg("toolTitle", theme.bold("kt ")) + theme.fg("muted", action);
			if (id) text += " " + theme.fg("accent", id);
			if (title) text += " " + theme.fg("dim", `"${title}"`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as KtToolDetails | undefined;
			const expandHint = theme.fg("dim", `(${keyHint("expandTools", "to expand")})`);
			const fallbackText = result.content[0];
			const fallback = () => new Text(fallbackText?.type === "text" ? fallbackText.text : "", 0, 0);

			if (!details) return fallback();

			if ("error" in details && details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			if (details.action === "list" && "tickets" in details) {
				const text = renderTicketList(theme, details.tickets, expanded, details.currentSessionId);
				return new Text(expanded ? text : `${text}\n${expandHint}`, 0, 0);
			}

			if (!("ticket" in details) || !details.ticket) return fallback();

			const ticket = details.ticket;
			const heading = renderTicketHeading(theme, ticket);
			const ACTION_LABELS: Record<string, string> = {
				create: "Created", update: "Updated", delete: "Deleted",
				start: "Started", close: "Closed", reopen: "Reopened", "add-note": "Note added to",
			};
			const label = ACTION_LABELS[details.action] ?? "";
			let text = label
				? theme.fg("success", "✓ ") + theme.fg("muted", `${label} `) + heading
				: heading;

			if (expanded && details.action === "show") {
				const t = ticket as TicketRecord;
				const lines = [text];
				if (t.description) lines.push(theme.fg("muted", `Description: ${t.description.slice(0, 200)}`));
				if (t.design) lines.push(theme.fg("muted", `Design: ${t.design.slice(0, 200)}`));
				if (t.tests) lines.push(theme.fg("muted", `Tests: ${t.tests.slice(0, 200)}`));
				text = lines.join("\n");
			}

			if (!expanded) text += `\n${expandHint}`;
			return new Text(text, 0, 0);
		},
	});

	// ── /kt command (TUI browser) ──────────────────────────────────────

	pi.registerCommand("kt", {
		description: "Browse and manage tickets",
		getArgumentCompletions: (prefix: string) => {
			const dir = getTicketsDir(process.cwd());
			const tickets = listTicketsSync(dir);
			if (!tickets.length) return null;
			const matches = filterTickets(tickets, prefix);
			if (!matches.length) return null;
			return matches.map((t) => ({
				value: t.title || t.id,
				label: `${t.id} ${t.title || "(untitled)"}`,
				description: `${t.status} • ${t.type} • p${t.priority}`,
			}));
		},
		handler: async (args, ctx) => {
			const dir = getTicketsDir(ctx.cwd);
			const tickets = await listTickets(dir);
			const currentSession = ctx.sessionManager.getSessionId();
			const searchTerm = (args ?? "").trim();

			if (!ctx.hasUI) {
				for (const t of tickets) console.log(formatTicketLine(t));
				return;
			}

			let nextPrompt: string | null = null;
			let rootTui: TUI | null = null;

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				rootTui = tui;
				let selector: TicketSelectorComponent | null = null;
				let actionMenu: TicketActionMenuComponent | null = null;
				let deleteConfirm: TicketDeleteConfirmComponent | null = null;
				let activeComponent: { render: (w: number) => string[]; invalidate: () => void; handleInput?: (d: string) => void; focused?: boolean } | null = null;
				let wrapperFocused = false;

				const setActive = (comp: typeof activeComponent) => {
					if (activeComponent && "focused" in activeComponent) activeComponent.focused = false;
					activeComponent = comp;
					if (activeComponent && "focused" in activeComponent) activeComponent.focused = wrapperFocused;
					tui.requestRender();
				};

				const resolveRecord = async (t: TicketFrontMatter): Promise<TicketRecord | null> => {
					const fp = getTicketPath(dir, t.id);
					if (!existsSync(fp)) { ctx.ui.notify(`Ticket ${t.id} not found`, "error"); return null; }
					return readTicketFile(fp, t.id);
				};

				const applyAction = async (record: TicketRecord, action: KtMenuAction): Promise<"stay" | "exit"> => {
					if (action === "work") {
						nextPrompt = buildWorkPrompt(record);
						done();
						return "exit";
					}
					if (action === "refine") {
						nextPrompt = buildRefinePrompt(record);
						done();
						return "exit";
					}
					if (action === "copyPath") {
						try { copyToClipboard(path.resolve(getTicketPath(dir, record.id))); ctx.ui.notify("Copied path", "info"); }
						catch (e) { ctx.ui.notify(e instanceof Error ? e.message : String(e), "error"); }
						return "stay";
					}
					if (action === "copyText") {
						const text = record.description ? `# ${record.title}\n\n${record.description}` : `# ${record.title}`;
						try { copyToClipboard(text); ctx.ui.notify("Copied text", "info"); }
						catch (e) { ctx.ui.notify(e instanceof Error ? e.message : String(e), "error"); }
						return "stay";
					}
					if (action === "delete") {
						return "stay"; // handled via delete confirm
					}
					if (action === "close" || action === "reopen") {
						const closing = action === "close";
						const result = await withLock(dir, record.id, ctx, async () => {
							const fp = getTicketPath(dir, record.id);
							if (!existsSync(fp)) return { error: "Not found" } as const;
							const t = await readTicketFile(fp, record.id);
							t.status = closing ? "closed" : "open";
							t.tests_passed = closing;
							if (closing) t.assignee = undefined;
							await writeTicketFile(fp, t);
							return t;
						});
						if (isError(result)) {
							ctx.ui.notify(result.error, "error");
						} else {
							selector?.setTickets(await listTickets(dir));
							ctx.ui.notify(`${closing ? "Closed" : "Reopened"} ${record.id}`, "info");
							refreshUI(ctx);
						}
						return "stay";
					}
					return "stay";
				};

				const showActionMenu = async (t: TicketFrontMatter) => {
					const record = await resolveRecord(t);
					if (!record) return;
					actionMenu = new TicketActionMenuComponent(
						theme, record,
						(action) => {
							if (action === "view") {
								void (async () => {
									const overlayAction = await ctx.ui.custom<KtOverlayAction>(
										(oTui, oTheme, _oKb, oDone) => new TicketDetailOverlayComponent(oTui, oTheme, record, oDone),
										{ overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" } },
									);
									if (overlayAction === "work") { await applyAction(record, "work"); return; }
									if (actionMenu) setActive(actionMenu);
								})();
								return;
							}
							if (action === "delete") {
								deleteConfirm = new TicketDeleteConfirmComponent(
									theme,
									`Delete ticket ${record.id}? This cannot be undone.`,
									(confirmed) => {
										if (!confirmed) { setActive(actionMenu); return; }
										void (async () => {
											const result = await withLock(dir, record.id, ctx, async () => {
												const fp = getTicketPath(dir, record.id);
												if (!existsSync(fp)) return { error: "Not found" } as const;
												const ticket = await readTicketFile(fp, record.id);
												await fs.unlink(fp);
												return ticket;
											});
											if (isError(result)) {
												ctx.ui.notify(result.error, "error");
											} else {
												const updated = await listTickets(dir);
												selector?.setTickets(updated);
												ctx.ui.notify(`Deleted ${record.id}`, "info");
												refreshUI(ctx);
											}
											setActive(selector);
										})();
									},
								);
								setActive(deleteConfirm);
								return;
							}
							void (async () => {
								const result = await applyAction(record, action);
								if (result === "stay") setActive(selector);
							})();
						},
						() => setActive(selector),
					);
					setActive(actionMenu);
				};

				selector = new TicketSelectorComponent(
					tui, theme, tickets,
					(t) => { void showActionMenu(t); },
					() => done(),
					searchTerm || undefined,
					currentSession,
					(t, action) => {
						nextPrompt = action === "refine" ? buildRefinePrompt(t) : buildWorkPrompt(t);
						done();
					},
				);
				setActive(selector);

				return {
					get focused() { return wrapperFocused; },
					set focused(v: boolean) {
						wrapperFocused = v;
						if (activeComponent && "focused" in activeComponent) activeComponent.focused = v;
					},
					render(w: number) { return activeComponent ? activeComponent.render(w) : []; },
					invalidate() { activeComponent?.invalidate(); },
					handleInput(d: string) { activeComponent?.handleInput?.(d); },
				};
			});

			if (nextPrompt) {
				ctx.ui.setEditorText(nextPrompt);
				(rootTui as TUI | null)?.requestRender();
			}
		},
	});

	// ── /kt-create command ─────────────────────────────────────────────

	pi.registerCommand("kt-create", {
		description: "Create an epic and tasks from a plan",
		handler: async (_args, ctx) => {
			const prompt =
				"I want to plan and create tickets for a new feature or project.\n\n" +
				"Follow this process strictly — do NOT create any tickets until step 3:\n\n" +
				"**Step 1: Understand** — If we already brainstormed this feature using the kbrainstorm skill " +
				"earlier in this session, skip to Step 2 — you already have the context. " +
				"Otherwise, ask me what I want to build. Then ask clarifying questions " +
				"about scope, constraints, edge cases, and priorities. Keep asking until you have a clear picture. " +
				"Do not proceed until I confirm you understand correctly.\n\n" +
				"**Step 2: Plan** — Present a proposed breakdown:\n" +
				"- One epic with a clear description\n" +
				"- Atomic tasks (each completable in one session)\n" +
				"- Dependencies between tasks\n" +
				"- Priority for each task (0=critical, 1=high, 2=normal, 3=low)\n" +
				"- For each task, draft: description, acceptance criteria, and test criteria\n\n" +
				"Ask me to review and adjust the plan before proceeding.\n\n" +
				"**Step 3: Create** — Once I approve the plan, create the tickets:\n" +
				"1. `kt create` the epic (type=epic) with description and acceptance criteria\n" +
				"2. `kt create` each task (type=task, parent=<epic-id>) with:\n" +
				"   - description: what to implement\n" +
				"   - acceptance: definition of done\n" +
				"   - tests: specific test criteria that must pass before closing\n" +
				"   - priority and deps as planned\n" +
				"3. Show the final ticket list with `kt list`\n\n" +
				"Start by asking me: what do you want to build?";
			ctx.ui.setEditorText(prompt);
		},
	});

	// ── /kt-run-all command ────────────────────────────────────────────

	pi.registerCommand("kt-run-all", {
		description: "Process all ready tickets, optionally in separate sessions",
		handler: async (_args, ctx) => {
			const dir = getTicketsDir(ctx.cwd);
			const tickets = await listTickets(dir);
			const ready = getReadyTickets(tickets).filter((t) => t.status === "open");

			if (!ready.length) {
				ctx.ui.notify("No ready tickets to process", "info");
				return;
			}

			const ticketList = ready.map((t) => `  ${t.id} ${t.title} [${t.type}, p${t.priority}]`).join("\n");

			if (!ctx.hasUI) {
				console.log(`Ready tickets:\n${ticketList}`);
				return;
			}

			// Ask user how to proceed
			const forkOptions = [
				"Fork a new session for each ticket",
				"Work through all in this session",
				"Cancel",
			];
			const forkChoice = await ctx.ui.select("kt-run-all: Session strategy", forkOptions);

			if (!forkChoice || forkChoice === "Cancel") return;

			if (forkChoice === "Work through all in this session") {
				// Inject prompt to work through all tickets
				const prompt =
					`Work through these tickets in order, one at a time. For each ticket:\n` +
					`1. Use \`kt start <id>\` to begin\n` +
					`2. Implement the work\n` +
					`3. Use \`kt close <id>\` when done (with tests_confirmed=true if it has tests)\n` +
					`4. Move to the next ticket\n\n` +
					`Ready tickets:\n${ticketList}\n\nStart with the first one.`;
				ctx.ui.setEditorText(prompt);
				return;
			}

			// Fork-each mode: process first ticket, inject context for next
			const firstTicket = ready[0];
			const record = await readTicketFile(getTicketPath(dir, firstTicket.id), firstTicket.id);

			const prompt =
				`Work on ticket ${firstTicket.id} "${firstTicket.title}".\n\n` +
				(record.description ? `Description: ${record.description}\n\n` : "") +
				(record.design ? `Design: ${record.design}\n\n` : "") +
				(record.acceptance ? `Acceptance: ${record.acceptance}\n\n` : "") +
				(record.tests ? `Tests: ${record.tests}\n\n` : "") +
				`Steps:\n1. \`kt start ${firstTicket.id}\`\n2. Implement the work\n3. \`kt close ${firstTicket.id}\`${record.tests ? " (with tests_confirmed=true after verifying tests)" : ""}\n\n` +
				`After closing, there are ${ready.length - 1} more tickets to process.`;

			// For fork-each, create a new session with the prompt
			const result = await ctx.newSession({
				parentSession: ctx.sessionManager.getSessionFile(),
				setup: async (sm) => {
					sm.appendMessage({
						role: "user",
						content: [{ type: "text", text: prompt }],
						timestamp: Date.now(),
					});
				},
			});

			if (result.cancelled) {
				ctx.ui.notify("Session creation cancelled", "info");
			}
		},
	});
}
