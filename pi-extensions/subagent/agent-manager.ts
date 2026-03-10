/**
 * Agent Manager TUI overlay component.
 *
 * Provides a browseable list of agents with fuzzy search, multi-select
 * for chain/parallel, a detail view, a task input screen, and a model
 * selector that persists changes to the agent's .md frontmatter.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry, Theme } from "@mariozechner/pi-coding-agent";
import { type Component, type TUI, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { type AgentConfig, updateAgentModel } from "./agents.js";
import { borderedRow, fuzzyFilterAgents, fuzzyScore, pad, renderBorderRow } from "./tui-helpers.js";
import type { AgentManagerResult } from "./types.js";

type ManagerScreen = "list" | "detail" | "task-input" | "model-select";

const LIST_VIEWPORT = 8;
const DETAIL_VIEWPORT = 12;
const MODEL_LIST_VIEWPORT = 10;

/** Agent Manager TUI component. */
export class AgentManagerComponent implements Component {
	private screen: ManagerScreen = "list";
	private agents: AgentConfig[];

	// List state
	private cursor = 0;
	private scrollOffset = 0;
	private filterQuery = "";
	private selected: string[] = [];

	// Detail state
	private detailAgent: AgentConfig | null = null;
	private detailScrollOffset = 0;

	// Task input state
	private taskBuffer = "";
	private taskCursor = 0;
	private taskMode: "single" | "chain" | "parallel" = "single";

	// Model-select state
	private modelList: Model<Api>[] = [];
	private modelCursor = 0;
	private modelScrollOffset = 0;
	private modelFilterQuery = "";

	constructor(
		private tui: TUI,
		private theme: Theme,
		agents: AgentConfig[],
		private modelRegistry: ModelRegistry,
		private done: (result: AgentManagerResult) => void,
	) {
		this.agents = agents;
	}

	// ── List helpers ─────────────────────────

	private filtered(): AgentConfig[] {
		return fuzzyFilterAgents(this.agents, this.filterQuery);
	}

	private clampCursor(filtered: AgentConfig[]): void {
		if (filtered.length === 0) {
			this.cursor = 0;
			this.scrollOffset = 0;
			return;
		}
		this.cursor = Math.max(0, Math.min(this.cursor, filtered.length - 1));
		const maxOff = Math.max(0, filtered.length - LIST_VIEWPORT);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOff));
		if (this.cursor < this.scrollOffset) this.scrollOffset = this.cursor;
		else if (this.cursor >= this.scrollOffset + LIST_VIEWPORT)
			this.scrollOffset = this.cursor - LIST_VIEWPORT + 1;
	}

	// ── Input handling ───────────────────────

	handleInput(data: string): void {
		switch (this.screen) {
			case "list": this.handleListInput(data); break;
			case "detail": this.handleDetailInput(data); break;
			case "task-input": this.handleTaskInput(data); break;
			case "model-select": this.handleModelSelectInput(data); break;
		}
		this.tui.requestRender();
	}

	private handleListInput(data: string): void {
		const list = this.filtered();

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.filterQuery) { this.filterQuery = ""; this.cursor = 0; this.scrollOffset = 0; return; }
			if (this.selected.length > 0) { this.selected.length = 0; return; }
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "return")) {
			const a = list[this.cursor];
			if (a) { this.detailAgent = a; this.detailScrollOffset = 0; this.screen = "detail"; }
			return;
		}
		if (matchesKey(data, "up")) { this.cursor--; this.clampCursor(list); return; }
		if (matchesKey(data, "down")) { this.cursor++; this.clampCursor(list); return; }
		if (matchesKey(data, "backspace")) {
			if (this.filterQuery) { this.filterQuery = this.filterQuery.slice(0, -1); this.cursor = 0; this.scrollOffset = 0; }
			return;
		}
		if (matchesKey(data, "tab")) {
			const a = list[this.cursor];
			if (a) this.selected.push(a.name);
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			const a = list[this.cursor];
			if (!a) return;
			const idx = this.selected.lastIndexOf(a.name);
			if (idx >= 0) this.selected.splice(idx, 1);
			return;
		}
		// ctrl+r: run / chain, ctrl+p: parallel
		if (matchesKey(data, "ctrl+r") || matchesKey(data, "ctrl+p")) {
			const isParallel = matchesKey(data, "ctrl+p");
			if (this.selected.length > 0) {
				this.taskMode = isParallel ? "parallel" : "chain";
			} else {
				const a = list[this.cursor];
				if (!a) return;
				this.selected = [a.name];
				this.taskMode = isParallel ? "parallel" : "single";
			}
			this.enterTaskInput();
			return;
		}
		// Printable char → filter
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.filterQuery += data;
			this.cursor = 0;
			this.scrollOffset = 0;
		}
	}

	private handleDetailInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.screen = "list"; return; }
		if (matchesKey(data, "up")) { this.detailScrollOffset = Math.max(0, this.detailScrollOffset - 1); return; }
		if (matchesKey(data, "down")) { this.detailScrollOffset++; return; }
		if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) { this.detailScrollOffset = Math.max(0, this.detailScrollOffset - DETAIL_VIEWPORT); return; }
		if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) { this.detailScrollOffset += DETAIL_VIEWPORT; return; }
		if (data === "m" && this.detailAgent) {
			this.enterModelSelect();
			return;
		}
		if (data === "l" || matchesKey(data, "ctrl+r")) {
			if (this.detailAgent) {
				this.selected = [this.detailAgent.name];
				this.taskMode = "single";
				this.enterTaskInput();
			}
			return;
		}
	}

	/** Enter model-select screen, loading available models from the registry. */
	private enterModelSelect(): void {
		this.modelList = this.modelRegistry.getAvailable();
		this.modelCursor = 0;
		this.modelScrollOffset = 0;
		this.modelFilterQuery = "";
		this.screen = "model-select";
	}

	/** Return models filtered by the current fuzzy query. */
	private filteredModels(): Model<Api>[] {
		const q = this.modelFilterQuery.trim();
		if (!q) return this.modelList;
		return this.modelList
			.map((m) => ({
				model: m,
				score: Math.max(
					fuzzyScore(q, m.id),
					fuzzyScore(q, m.provider) * 0.8,
					fuzzyScore(q, m.name) * 0.6,
				),
			}))
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score)
			.map((x) => x.model);
	}

	/** Clamp model cursor and scroll offset to the filtered list bounds. */
	private clampModelCursor(filtered: Model<Api>[]): void {
		if (filtered.length === 0) {
			this.modelCursor = 0;
			this.modelScrollOffset = 0;
			return;
		}
		this.modelCursor = Math.max(0, Math.min(this.modelCursor, filtered.length - 1));
		const maxOff = Math.max(0, filtered.length - MODEL_LIST_VIEWPORT);
		this.modelScrollOffset = Math.max(0, Math.min(this.modelScrollOffset, maxOff));
		if (this.modelCursor < this.modelScrollOffset) this.modelScrollOffset = this.modelCursor;
		else if (this.modelCursor >= this.modelScrollOffset + MODEL_LIST_VIEWPORT)
			this.modelScrollOffset = this.modelCursor - MODEL_LIST_VIEWPORT + 1;
	}

	private handleModelSelectInput(data: string): void {
		const list = this.filteredModels();

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.modelFilterQuery) {
				this.modelFilterQuery = "";
				this.modelCursor = 0;
				this.modelScrollOffset = 0;
				return;
			}
			this.screen = "detail";
			return;
		}
		if (matchesKey(data, "return")) {
			const model = list[this.modelCursor];
			if (model && this.detailAgent) {
				updateAgentModel(this.detailAgent, model.id);
				this.screen = "detail";
			}
			return;
		}
		if (matchesKey(data, "up")) { this.modelCursor--; this.clampModelCursor(list); return; }
		if (matchesKey(data, "down")) { this.modelCursor++; this.clampModelCursor(list); return; }
		if (matchesKey(data, "backspace")) {
			if (this.modelFilterQuery) {
				this.modelFilterQuery = this.modelFilterQuery.slice(0, -1);
				this.modelCursor = 0;
				this.modelScrollOffset = 0;
			}
			return;
		}
		// Printable char → filter
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.modelFilterQuery += data;
			this.modelCursor = 0;
			this.modelScrollOffset = 0;
		}
	}

	private enterTaskInput(): void {
		this.taskBuffer = "";
		this.taskCursor = 0;
		this.screen = "task-input";
	}

	private handleTaskInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.screen = this.detailAgent && this.taskMode === "single" ? "detail" : "list";
			return;
		}
		if (matchesKey(data, "return")) {
			const task = this.taskBuffer.trim();
			if (!task) return;
			if (this.taskMode === "single") {
				this.done({ action: "run", agent: this.selected[0], task });
			} else if (this.taskMode === "chain") {
				this.done({ action: "chain", agents: [...this.selected], task });
			} else {
				const tasks = this.selected.map((name) => ({ agent: name, task }));
				this.done({ action: "parallel", tasks });
			}
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.taskCursor > 0) {
				this.taskBuffer =
					this.taskBuffer.slice(0, this.taskCursor - 1) + this.taskBuffer.slice(this.taskCursor);
				this.taskCursor--;
			}
			return;
		}
		if (matchesKey(data, "delete")) {
			if (this.taskCursor < this.taskBuffer.length) {
				this.taskBuffer =
					this.taskBuffer.slice(0, this.taskCursor) + this.taskBuffer.slice(this.taskCursor + 1);
			}
			return;
		}
		if (matchesKey(data, "left")) { this.taskCursor = Math.max(0, this.taskCursor - 1); return; }
		if (matchesKey(data, "right")) { this.taskCursor = Math.min(this.taskBuffer.length, this.taskCursor + 1); return; }
		if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) { this.taskCursor = 0; return; }
		if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) { this.taskCursor = this.taskBuffer.length; return; }
		// Printable char
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.taskBuffer =
				this.taskBuffer.slice(0, this.taskCursor) + data + this.taskBuffer.slice(this.taskCursor);
			this.taskCursor++;
		}
	}

	// ── Rendering ────────────────────────────

	render(width: number): string[] {
		const w = Math.min(width, 84);
		switch (this.screen) {
			case "list": return this.renderList(w);
			case "detail": return this.renderDetail(w);
			case "task-input": return this.renderTaskInput(w);
			case "model-select": return this.renderModelSelect(w);
		}
	}

	private renderList(w: number): string[] {
		const lines: string[] = [];
		const filtered = this.filtered();
		this.clampCursor(filtered);

		lines.push(renderBorderRow(` Agents [${this.agents.length}] `, w, this.theme, "header"));
		lines.push(borderedRow("", w, this.theme));

		// Search bar
		const cursor = this.theme.fg("accent", "│");
		const placeholder = this.theme.fg("dim", "\x1b[3mtype to filter...\x1b[23m");
		const queryDisplay = this.filterQuery ? `${this.filterQuery}${cursor}` : `${cursor}${placeholder}`;
		lines.push(borderedRow(` ${this.theme.fg("dim", "◎")}  ${queryDisplay}`, w, this.theme));
		lines.push(borderedRow("", w, this.theme));

		// Agent list
		const innerW = w - 2;
		const nameWidth = 16;
		const modelWidth = 12;
		const scopeWidth = 7;
		const startIdx = this.scrollOffset;
		const endIdx = Math.min(filtered.length, startIdx + LIST_VIEWPORT);
		const visible = filtered.slice(startIdx, endIdx);

		if (filtered.length === 0) {
			lines.push(borderedRow(` ${this.theme.fg("dim", "No matching agents")}`, w, this.theme));
			for (let i = 1; i < LIST_VIEWPORT; i++) lines.push(borderedRow("", w, this.theme));
		} else {
			for (let i = 0; i < visible.length; i++) {
				const agent = visible[i];
				const index = startIdx + i;
				const isCursor = index === this.cursor;
				const selCount = this.selected.filter((n) => n === agent.name).length;

				const cursorChar = isCursor ? this.theme.fg("accent", "▸") : " ";
				const selectBadge = selCount > 1
					? this.theme.fg("accent", `×${selCount}`.padStart(2))
					: selCount === 1 ? this.theme.fg("accent", " ✓") : "  ";
				const prefix = `${cursorChar}${selectBadge} `;

				const modelRaw = agent.model ?? "default";
				const modelDisplay = modelRaw.includes("/") ? modelRaw.split("/").pop() ?? modelRaw : modelRaw;
				const nameText = isCursor ? this.theme.fg("accent", agent.name) : agent.name;
				const modelText = this.theme.fg("dim", modelDisplay);
				const scopeLabel = agent.source === "project" ? "[proj]" : agent.source === "bundled" ? "[built-in]" : "[user]";
				const scopeBadge = this.theme.fg("dim", scopeLabel);
				const descText = this.theme.fg("dim", agent.description);

				const descWidth = Math.max(0, innerW - 1 - visibleWidth(prefix) - nameWidth - modelWidth - scopeWidth - 3);
				const line =
					prefix +
					pad(truncateToWidth(nameText, nameWidth), nameWidth) +
					" " +
					pad(truncateToWidth(modelText, modelWidth), modelWidth) +
					" " +
					pad(scopeBadge, scopeWidth) +
					" " +
					truncateToWidth(descText, descWidth);

				lines.push(borderedRow(` ${line}`, w, this.theme));
			}
			for (let i = visible.length; i < LIST_VIEWPORT; i++) lines.push(borderedRow("", w, this.theme));
		}

		// Selection preview or description
		const selectedPreview = this.selected.length > 0
			? truncateToWidth(this.selected.join(" → "), w - 4)
			: "";
		lines.push(borderedRow("", w, this.theme));
		if (selectedPreview) {
			lines.push(borderedRow(` ${this.theme.fg("dim", selectedPreview)}`, w, this.theme));
		} else {
			const cursorAgent = filtered[this.cursor];
			const desc = cursorAgent ? truncateToWidth(cursorAgent.description, w - 4) : "";
			lines.push(borderedRow(desc ? ` ${this.theme.fg("dim", desc)}` : "", w, this.theme));
		}
		lines.push(borderedRow("", w, this.theme));

		// Footer
		const selCount = this.selected.length;
		const footerText = selCount > 1
			? ` [ctrl+r] chain  [ctrl+p] parallel  [tab] add  [shift+tab] remove  [esc] clear (${selCount}) `
			: selCount === 1
				? " [ctrl+r] run  [ctrl+p] parallel  [tab] add more  [shift+tab] remove  [esc] clear "
				: " [enter] view  [ctrl+r] run  [tab] select  [esc] close ";
		lines.push(renderBorderRow(footerText, w, this.theme, "footer"));

		return lines;
	}

	private renderDetail(w: number): string[] {
		const agent = this.detailAgent;
		if (!agent) return this.renderList(w);

		const lines: string[] = [];
		const scopeBadge = agent.source === "project" ? "[proj]" : agent.source === "bundled" ? "[built-in]" : "[user]";
		lines.push(renderBorderRow(` ${agent.name} ${scopeBadge} `, w, this.theme, "header"));
		lines.push(borderedRow("", w, this.theme));

		const contentWidth = w - 4;
		const contentLines: string[] = [];

		const field = (label: string, value: string) => {
			const lbl = this.theme.fg("dim", pad(label, 10));
			return `${lbl}${truncateToWidth(value, Math.max(0, contentWidth - 10))}`;
		};

		const tools = agent.tools?.length ? agent.tools.join(", ") : "(default)";
		contentLines.push(field("Model:", agent.model ?? "default"));
		contentLines.push(field("Tools:", tools));
		contentLines.push(field("Source:", agent.source));
		contentLines.push("");
		contentLines.push(truncateToWidth("── System Prompt ──", contentWidth));

		const prompt = agent.systemPrompt || "(empty)";
		for (const line of prompt.split("\n")) {
			// Wrap long lines
			if (visibleWidth(line) <= contentWidth) {
				contentLines.push(line);
			} else {
				let remaining = line;
				while (remaining.length > 0) {
					contentLines.push(remaining.slice(0, contentWidth));
					remaining = remaining.slice(contentWidth);
				}
			}
		}

		// Clamp scroll
		const maxOff = Math.max(0, contentLines.length - DETAIL_VIEWPORT);
		this.detailScrollOffset = Math.max(0, Math.min(this.detailScrollOffset, maxOff));

		const visible = contentLines.slice(this.detailScrollOffset, this.detailScrollOffset + DETAIL_VIEWPORT);
		for (const cl of visible) lines.push(borderedRow(` ${cl}`, w, this.theme));
		for (let i = visible.length; i < DETAIL_VIEWPORT; i++) lines.push(borderedRow("", w, this.theme));

		// Scroll info
		const above = this.detailScrollOffset;
		const below = Math.max(0, contentLines.length - this.detailScrollOffset - DETAIL_VIEWPORT);
		let scrollInfo = "";
		if (above > 0) scrollInfo += `↑ ${above} more`;
		if (below > 0) scrollInfo += `${scrollInfo ? "  " : ""}↓ ${below} more`;
		lines.push(borderedRow(scrollInfo ? ` ${this.theme.fg("dim", scrollInfo)}` : "", w, this.theme));

		lines.push(renderBorderRow(" [l] launch  [m] model  [↑↓] scroll  [esc] back ", w, this.theme, "footer"));
		return lines;
	}

	private renderTaskInput(w: number): string[] {
		const lines: string[] = [];

		let title: string;
		if (this.taskMode === "single") title = `Run: ${this.selected[0]}`;
		else if (this.taskMode === "chain") title = `Chain: ${this.selected.join(" → ")}`;
		else title = `Parallel: ${this.selected.join(", ")}`;

		lines.push(renderBorderRow(` ${truncateToWidth(title, w - 6)} `, w, this.theme, "header"));
		lines.push(borderedRow("", w, this.theme));
		lines.push(borderedRow(` ${this.theme.fg("dim", "Task:")}`, w, this.theme));

		// Text input box
		const innerW = w - 2;
		const boxW = Math.max(10, innerW - 4);
		const top = `┌${"─".repeat(boxW)}┐`;
		const bottom = `└${"─".repeat(boxW)}┘`;

		lines.push(borderedRow(` ${top}`, w, this.theme));

		// Render buffer with cursor
		const before = this.taskBuffer.slice(0, this.taskCursor);
		const after = this.taskBuffer.slice(this.taskCursor);
		const cursorChar = after.length > 0 ? this.theme.inverse(after[0]) : this.theme.inverse(" ");
		const display = truncateToWidth(before + cursorChar + after.slice(1), boxW);
		lines.push(borderedRow(` │${pad(display, boxW)}│`, w, this.theme));

		lines.push(borderedRow(` ${bottom}`, w, this.theme));
		lines.push(borderedRow("", w, this.theme));
		lines.push(renderBorderRow(" [enter] run  [esc] cancel ", w, this.theme, "footer"));

		return lines;
	}

	private renderModelSelect(w: number): string[] {
		const agent = this.detailAgent;
		if (!agent) return this.renderList(w);

		const lines: string[] = [];
		const filtered = this.filteredModels();
		this.clampModelCursor(filtered);

		const currentModel = agent.model ?? "default";
		lines.push(renderBorderRow(` Model for ${agent.name} [${currentModel}] `, w, this.theme, "header"));
		lines.push(borderedRow("", w, this.theme));

		// Search bar
		const cursor = this.theme.fg("accent", "│");
		const placeholder = this.theme.fg("dim", "\x1b[3mtype to filter models...\x1b[23m");
		const queryDisplay = this.modelFilterQuery ? `${this.modelFilterQuery}${cursor}` : `${cursor}${placeholder}`;
		lines.push(borderedRow(` ${this.theme.fg("dim", "◎")}  ${queryDisplay}`, w, this.theme));
		lines.push(borderedRow("", w, this.theme));

		// Model list
		const innerW = w - 2;
		const idWidth = 32;
		const providerWidth = 14;
		const startIdx = this.modelScrollOffset;
		const endIdx = Math.min(filtered.length, startIdx + MODEL_LIST_VIEWPORT);
		const visible = filtered.slice(startIdx, endIdx);

		if (filtered.length === 0) {
			lines.push(borderedRow(` ${this.theme.fg("dim", "No matching models")}`, w, this.theme));
			for (let i = 1; i < MODEL_LIST_VIEWPORT; i++) lines.push(borderedRow("", w, this.theme));
		} else {
			for (let i = 0; i < visible.length; i++) {
				const model = visible[i];
				const index = startIdx + i;
				const isCursor = index === this.modelCursor;
				const isCurrent = model.id === agent.model;

				const cursorChar = isCursor ? this.theme.fg("accent", "▸") : " ";
				const currentBadge = isCurrent ? this.theme.fg("success", " ✓") : "  ";
				const prefix = `${cursorChar}${currentBadge} `;

				const idText = isCursor ? this.theme.fg("accent", model.id) : model.id;
				const providerText = this.theme.fg("dim", model.provider);
				const reasoningBadge = model.reasoning ? this.theme.fg("warning", "⚡") : " ";
				const ctxText = this.theme.fg("dim", `${Math.round(model.contextWindow / 1000)}k`);

				const metaWidth = Math.max(0, innerW - 1 - visibleWidth(prefix) - idWidth - providerWidth - 6);
				const line =
					prefix +
					pad(truncateToWidth(idText, idWidth), idWidth) +
					" " +
					pad(truncateToWidth(providerText, providerWidth), providerWidth) +
					" " +
					reasoningBadge +
					" " +
					pad(truncateToWidth(ctxText, metaWidth), metaWidth);

				lines.push(borderedRow(` ${line}`, w, this.theme));
			}
			for (let i = visible.length; i < MODEL_LIST_VIEWPORT; i++) lines.push(borderedRow("", w, this.theme));
		}

		// Model count / scroll info
		lines.push(borderedRow("", w, this.theme));
		const countInfo = `${filtered.length} model${filtered.length !== 1 ? "s" : ""}`;
		lines.push(borderedRow(` ${this.theme.fg("dim", countInfo)}`, w, this.theme));
		lines.push(borderedRow("", w, this.theme));

		lines.push(renderBorderRow(" [enter] select  [↑↓] scroll  [esc] back ", w, this.theme, "footer"));
		return lines;
	}

	invalidate(): void {}
}
