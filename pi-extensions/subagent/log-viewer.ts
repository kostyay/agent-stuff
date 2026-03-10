/**
 * Log Viewer TUI overlay component.
 *
 * Displays a live-streaming view of an agent's text output and tool calls.
 * Auto-scrolls to bottom by default. Scrolling up pauses auto-scroll;
 * pressing End resumes tailing.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { type Component, type TUI, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { expandTabs, formatToolCall } from "./formatting.js";
import { agentColor, borderedRow, renderBorderRow } from "./tui-helpers.js";
import type { RunState } from "./types.js";

/** Log Viewer TUI component with auto-scroll/tail support. */
export class LogViewerComponent implements Component {
	private scrollOffset = 0;
	private autoScroll = true;
	private refreshTimer: ReturnType<typeof setInterval>;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private state: RunState,
		private displayIndex: number,
		private done: () => void,
	) {
		this.refreshTimer = setInterval(() => {
			this.tui.requestRender();
		}, 200);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			clearInterval(this.refreshTimer);
			this.done();
			return;
		}
		if (matchesKey(data, "up")) {
			this.autoScroll = false;
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.scrollOffset++;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
			this.autoScroll = false;
			this.scrollOffset = Math.max(0, this.scrollOffset - 20);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) {
			this.scrollOffset += 20;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "end") || data === "G") {
			this.autoScroll = true;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "home") || data === "g") {
			this.autoScroll = false;
			this.scrollOffset = 0;
			this.tui.requestRender();
			return;
		}
	}

	render(width: number): string[] {
		const w = Math.min(width, 120);
		const lines: string[] = [];

		// Header
		const color = agentColor(this.displayIndex);
		const statusIcon = this.state.status === "running" ? "●"
			: this.state.status === "done" ? "✓"
			: this.state.status === "aborted" ? "⊘" : "✗";
		const headerText = ` ${this.displayIndex} ${this.state.agent} ${statusIcon} `;
		// Render header with agent's assigned color
		const innerW = w - 2;
		const padLen = Math.max(0, innerW - visibleWidth(headerText));
		const padLeft = Math.floor(padLen / 2);
		const padRight = padLen - padLeft;
		lines.push(
			this.theme.fg("border", "╭" + "─".repeat(padLeft)) +
			this.theme.fg(color, headerText) +
			this.theme.fg("border", "─".repeat(padRight) + "╮"),
		);

		// Flatten log entries into rendered display lines
		const contentW = w - 3;
		const fgBound = this.theme.fg.bind(this.theme);
		const rendered: string[] = [];

		for (const entry of this.state.logEntries) {
			switch (entry.kind) {
				case "text":
					rendered.push(expandTabs(entry.line));
					break;
				case "toolCall":
					rendered.push(formatToolCall(entry.name, entry.args, fgBound));
					break;
				case "toolOutput": {
					const outputLines = entry.text.split("\n");
					for (const ol of outputLines) {
						rendered.push(this.theme.fg("dim", truncateToWidth(expandTabs(ol), contentW)));
					}
					break;
				}
				case "separator":
					rendered.push(this.theme.fg("dim", "─".repeat(Math.min(40, contentW))));
					break;
			}
		}
		// Append partial streaming text
		if (this.state.logPartial) {
			rendered.push(expandTabs(this.state.logPartial));
		}

		const viewportHeight = 20;

		if (rendered.length === 0) {
			lines.push(borderedRow("", w, this.theme));
			lines.push(borderedRow(` ${this.theme.fg("dim", "Waiting for output...")}`, w, this.theme));
			for (let i = 2; i < viewportHeight; i++) lines.push(borderedRow("", w, this.theme));
		} else {
			// Auto-scroll: snap to bottom
			if (this.autoScroll) {
				this.scrollOffset = Math.max(0, rendered.length - viewportHeight);
			}

			// Clamp scroll offset
			const maxOffset = Math.max(0, rendered.length - viewportHeight);
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));

			const visible = rendered.slice(this.scrollOffset, this.scrollOffset + viewportHeight);
			for (const renderedLine of visible) {
				lines.push(borderedRow(` ${truncateToWidth(renderedLine, contentW)}`, w, this.theme));
			}
			for (let i = visible.length; i < viewportHeight; i++) {
				lines.push(borderedRow("", w, this.theme));
			}
		}

		// Scroll info line
		const above = this.scrollOffset;
		const below = Math.max(0, rendered.length - this.scrollOffset - viewportHeight);
		let scrollInfo = "";
		if (above > 0) scrollInfo += `↑ ${above}`;
		if (below > 0) scrollInfo += `${scrollInfo ? "  " : ""}↓ ${below}`;
		const tailBadge = this.autoScroll
			? this.theme.fg("success", " TAIL")
			: this.theme.fg("warning", " PAUSED");
		const scrollText = scrollInfo
			? ` ${this.theme.fg("dim", scrollInfo)}${tailBadge}`
			: ` ${this.theme.fg("dim", `${rendered.length} lines`)}${tailBadge}`;
		lines.push(borderedRow(scrollText, w, this.theme));

		// Footer
		const footerHint = this.autoScroll
			? " [↑/PgUp] scroll  [esc] close "
			: " [↑↓/PgUp/PgDn] scroll  [End] resume tail  [esc] close ";
		lines.push(renderBorderRow(footerHint, w, this.theme, "footer"));

		return lines;
	}

	invalidate(): void {}
}
