/**
 * Terminal Progress Indicator
 *
 * Sends OSC 9;4 escape sequences to show an indeterminate progress pulse
 * in the terminal tab/titlebar while the agent is working.
 * Clears the indicator when the agent finishes or waits for user input.
 *
 * Supported terminals: Ghostty, iTerm2, WezTerm, Windows Terminal, ConEmu.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** OSC 9;4 progress states. */
const PROGRESS_CLEAR = 0;
const PROGRESS_INDETERMINATE = 3;

/** Whether the progress indicator is currently active. */
let active = false;

/**
 * Write an OSC 9;4 progress escape sequence to stdout.
 *
 * @param state - Progress state: 0=remove, 1=normal, 2=error, 3=indeterminate, 4=warning.
 * @param value - Progress percentage (0–100). Ignored for indeterminate/remove states.
 */
function sendProgress(state: number, value = 0): void {
	process.stdout.write(`\x1b]9;4;${state};${value}\x07`);
}

/** Start the indeterminate progress pulse if not already active. */
function startProgress(): void {
	if (active) return;
	active = true;
	sendProgress(PROGRESS_INDETERMINATE);
}

/** Clear the progress indicator if currently active. */
function clearProgress(): void {
	if (!active) return;
	active = false;
	sendProgress(PROGRESS_CLEAR);
}

/** Terminal progress indicator — OSC 9;4 pulse while agent is working. */
export default function terminalProgressExtension(pi: ExtensionAPI): void {
	pi.on("turn_start", async () => {
		startProgress();
	});

	pi.on("agent_end", async () => {
		clearProgress();
	});

	pi.events.on("waiting_for_input", () => {
		clearProgress();
	});

	// Ensure progress is cleared on process exit (prevents stuck indicator on crash).
	process.on("exit", () => {
		if (active) {
			sendProgress(PROGRESS_CLEAR);
		}
	});
}
