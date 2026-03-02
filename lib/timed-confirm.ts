/**
 * Timed Confirm — a reusable confirmation dialog with a countdown timer.
 *
 * Shows a bordered confirmation prompt that auto-confirms after a
 * configurable number of seconds. The user can press Enter to confirm
 * immediately or Escape to cancel.
 */

import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Container, Key, Text, matchesKey } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Configuration for the timed confirmation dialog. */
export interface TimedConfirmOptions {
	/** Dialog title. */
	title: string;
	/** Descriptive message shown below the title. */
	message: string;
	/** Countdown duration in seconds. Defaults to 5. */
	seconds?: number;
	/** Value returned when the timer expires. Defaults to `true`. */
	defaultValue?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Default countdown duration in seconds. */
const DEFAULT_SECONDS = 5;

/**
 * Show a confirmation dialog with a countdown timer.
 *
 * Auto-resolves with `defaultValue` (default `true`) when the timer expires.
 * The user can press Enter to confirm or Escape to cancel at any time.
 *
 * @example
 * ```ts
 * const ok = await timedConfirm(ctx, {
 *   title: "Merge PR",
 *   message: `Merge PR #${pr.number} into main?`,
 *   seconds: 5,
 * });
 * ```
 */
export async function timedConfirm(
	ctx: ExtensionCommandContext,
	options: TimedConfirmOptions,
): Promise<boolean> {
	const { title, message, seconds = DEFAULT_SECONDS, defaultValue = true } = options;

	return ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
		let remaining = seconds;
		let resolved = false;

		const finish = (value: boolean) => {
			if (resolved) return;
			resolved = true;
			clearInterval(timer);
			done(value);
		};

		const timer = setInterval(() => {
			remaining--;
			if (remaining <= 0) {
				finish(defaultValue);
			} else {
				tui.requestRender();
			}
		}, 1000);

		const container = new Container();
		const borderTop = new DynamicBorder((s: string) => theme.fg("accent", s));
		const titleText = new Text("", 1, 0);
		const messageText = new Text("", 1, 0);
		const helpText = new Text("", 1, 0);
		const borderBottom = new DynamicBorder((s: string) => theme.fg("accent", s));

		container.addChild(borderTop);
		container.addChild(titleText);
		container.addChild(messageText);
		container.addChild(helpText);
		container.addChild(borderBottom);

		const defaultLabel = defaultValue ? "confirm" : "cancel";

		const updateTexts = () => {
			titleText.setText(theme.fg("accent", theme.bold(title)));
			messageText.setText(message);
			helpText.setText(
				theme.fg("dim", `Auto-${defaultLabel} in ${remaining}s - enter confirm - esc cancel`),
			);
		};
		updateTexts();

		return {
			render: (w: number) => {
				updateTexts();
				return container.render(w);
			},
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, Key.enter)) {
					finish(true);
				} else if (matchesKey(data, Key.escape)) {
					finish(false);
				}
			},
		};
	});
}
