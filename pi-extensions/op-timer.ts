/**
 * Operation Timer
 *
 * Displays a live elapsed-time counter above the editor while the agent
 * is working. Shows two timers:
 *   1. Total operation duration (turn_start → agent_end)
 *   2. Current tool execution duration (tool_call → tool_execution_end)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

/** Format milliseconds as compact duration (e.g. "5s", "2m 03s", "1h 05m"). */
function formatElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (min < 60) return `${min}m ${String(sec).padStart(2, "0")}s`;
	const hr = Math.floor(min / 60);
	return `${hr}h ${String(min % 60).padStart(2, "0")}m`;
}

/** Operation timer — live widget above the editor. */
export default function operationTimerExtension(pi: ExtensionAPI): void {
	let operationStart: number | null = null;
	let toolStart: number | null = null;
	let toolName: string | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	let tuiRef: { requestRender: () => void } | null = null;
	let ctx: ExtensionContext | null = null;
	let widgetActive = false;

	function ensureWidget(): void {
		if (widgetActive || !ctx) return;
		widgetActive = true;
		ctx.ui.setWidget("op-timer", (_tui, theme) => {
			tuiRef = _tui;
			return {
				render(): string[] {
					if (operationStart === null) return [];
					const now = Date.now();
					const opElapsed = formatElapsed(now - operationStart);
					let line = ` ${theme.fg("warning", `⏱ ${opElapsed}`)}`;
					if (toolStart !== null && toolName) {
						const toolElapsed = formatElapsed(now - toolStart);
						line += theme.fg("dim", " │ ");
						line += theme.fg("accent", toolName);
						line += theme.fg("muted", ` ${toolElapsed}`);
					}
					return [line];
				},
				invalidate(): void {},
			};
		});
	}

	function startOperation(): void {
		if (operationStart !== null) return;
		operationStart = Date.now();
		ensureWidget();
		timer = setInterval(() => tuiRef?.requestRender(), 1000);
	}

	function stopOperation(): void {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		operationStart = null;
		toolStart = null;
		toolName = null;
		tuiRef = null;
		if (widgetActive) {
			ctx?.ui.setWidget("op-timer", undefined);
			widgetActive = false;
		}
	}

	pi.on("session_start", async (_event, c) => {
		ctx = c;
	});

	pi.on("turn_start", async () => {
		startOperation();
	});

	pi.on("tool_call", async (event) => {
		toolName = event.toolName;
		toolStart = Date.now();
	});

	pi.on("tool_execution_end", async () => {
		toolName = null;
		toolStart = null;
	});

	pi.on("agent_end", async () => {
		stopOperation();
	});

	pi.events.on("waiting_for_input", () => {
		stopOperation();
	});

	pi.on("session_switch", async (event) => {
		if (event.reason === "new") stopOperation();
	});
}
