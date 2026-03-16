/**
 * ask-question-ui — Reusable TUI for asking a single question
 *
 * Renders either a freeform text editor or a multiple-choice list with optional
 * inline editing. Used by kbrainstorm extension and available for any extension
 * needing interactive Q&A.
 */

import type { ExtensionUIContext, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { EditorTheme } from "@mariozechner/pi-tui";
import { Editor, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

// ── Public types ─────────────────────────────────────────────────────────────

/** A selectable option with an optional description. */
export interface OptionWithDesc {
	label: string;
	description?: string;
}

/** Parameters for showAskQuestion. */
export interface AskQuestionUIParams {
	question: string;
	context?: string;
	options?: OptionWithDesc[];
}

/** Result returned from showAskQuestion, or null if the user skipped. */
export interface AskQuestionUIResult {
	answer: string;
	wasCustom: boolean;
	index?: number;
}

/** Details shape stored alongside tool results for rendering. */
export interface AskQuestionDetails {
	question: string;
	context?: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
}

// ── Internal types ───────────────────────────────────────────────────────────

/** Display option — extends OptionWithDesc with a freeform-slot flag. */
interface DisplayOption extends OptionWithDesc {
	isOther?: boolean;
}

/** Minimal theme interface — subset of Theme used by render helpers. */
interface ThemeFg {
	fg: (color: ThemeColor, text: string) => string;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Build the EditorTheme shared by both question modes. */
function buildEditorTheme(theme: ThemeFg): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

/** Render the question header: top border, question text, optional context, trailing blank line. */
function renderQuestionHeader(
	lines: string[],
	add: (s: string) => void,
	theme: ThemeFg,
	params: AskQuestionUIParams,
	contentWidth: number,
	width: number,
): void {
	add(theme.fg("accent", "─".repeat(width)));
	for (const line of wrapTextWithAnsi(theme.fg("text", ` ${params.question}`), contentWidth)) {
		add(line);
	}
	if (params.context) {
		lines.push("");
		for (const line of wrapTextWithAnsi(theme.fg("muted", `   ${params.context}`), contentWidth)) {
			add(line);
		}
	}
	lines.push("");
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Show an interactive TUI question.
 *
 * - With `params.options`: numbered list with Tab-toggled inline editor,
 *   plus a "Type something." freeform fallback. Supports ↑↓, Enter, 1-9 quick select.
 * - Without options: freeform text editor.
 *
 * @param ui - The ExtensionUIContext (must support `custom`).
 * @param onWaiting - Called before the UI blocks, so callers can emit events.
 * @param params - Question text, optional context, and optional options.
 * @returns The user's answer, or null if they pressed Escape.
 */
export async function showAskQuestion(
	ui: ExtensionUIContext,
	onWaiting: () => void,
	params: AskQuestionUIParams,
): Promise<AskQuestionUIResult | null> {
	if (!params.options?.length) {
		return showFreeformQuestion(ui, onWaiting, params);
	}
	return showMultipleChoiceQuestion(ui, onWaiting, params);
}

// ── Freeform question ────────────────────────────────────────────────────────

/** Freeform text editor question — no predefined options. */
async function showFreeformQuestion(
	ui: ExtensionUIContext,
	onWaiting: () => void,
	params: AskQuestionUIParams,
): Promise<AskQuestionUIResult | null> {
	onWaiting();

	const result = await ui.custom<{ answer: string } | null>((tui, theme, _kb, done) => {
		let cachedLines: string[] | undefined;
		const editor = new Editor(tui, buildEditorTheme(theme));

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (trimmed) done({ answer: trimmed });
		};

		function refresh(): void {
			cachedLines = undefined;
			tui.requestRender();
		}

		function handleInput(data: string): void {
			if (matchesKey(data, Key.escape)) {
				done(null);
				return;
			}
			editor.handleInput(data);
			refresh();
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const add = (s: string): void => { lines.push(truncateToWidth(s, width)); };
			const contentWidth = Math.min(width - 4, 100);

			renderQuestionHeader(lines, add, theme, params, contentWidth, width);

			add(theme.fg("muted", " Your answer:"));
			for (const line of editor.render(width - 2)) {
				add(` ${line}`);
			}

			lines.push("");
			add(theme.fg("dim", " Enter to submit • Shift+Enter for newline • Esc to skip"));
			add(theme.fg("accent", "─".repeat(width)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => { cachedLines = undefined; },
			handleInput,
		};
	});

	if (!result) return null;
	return { answer: result.answer, wasCustom: true };
}

// ── Multiple-choice question ─────────────────────────────────────────────────

/**
 * Multiple-choice question with optional inline editing.
 *
 * The editor is hidden by default — the user navigates with ↑↓ and submits with
 * Enter or 1-9. Tab toggles an inline editor pre-filled with the selected option.
 * The "Type something." fallback auto-enters editing mode when selected.
 */
async function showMultipleChoiceQuestion(
	ui: ExtensionUIContext,
	onWaiting: () => void,
	params: AskQuestionUIParams,
): Promise<AskQuestionUIResult | null> {
	const allOptions: DisplayOption[] = [...params.options!, { label: "Type something.", isOther: true }];

	onWaiting();

	return ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>(
		(tui, theme, _kb, done) => {
			let optionIndex = 0;
			let editing = false;
			let cachedLines: string[] | undefined;
			const editor = new Editor(tui, buildEditorTheme(theme));

			editor.onSubmit = (value) => {
				const trimmed = value.trim();
				if (!trimmed) return;
				const sourceOpt = allOptions[optionIndex];
				const isOther = sourceOpt?.isOther === true;
				done({
					answer: trimmed,
					wasCustom: isOther || trimmed !== sourceOpt?.label,
					index: isOther ? undefined : optionIndex + 1,
				});
			};

			function refresh(): void {
				cachedLines = undefined;
				tui.requestRender();
			}

			function enterEditMode(): void {
				const opt = allOptions[optionIndex];
				editor.setText(opt.isOther ? "" : opt.label);
				editing = true;
				refresh();
			}

			function submitOption(index: number): void {
				const opt = allOptions[index];
				if (opt.isOther) {
					optionIndex = index;
					enterEditMode();
					return;
				}
				done({ answer: opt.label, wasCustom: false, index: index + 1 });
			}

			function handleInput(data: string): void {
				// Editing mode — editor owns input, Esc exits back to selection
				if (editing) {
					if (matchesKey(data, Key.escape)) {
						editing = false;
						refresh();
						return;
					}
					editor.handleInput(data);
					refresh();
					return;
				}

				// Selection mode
				if (data.length === 1 && data >= "1" && data <= "9") {
					const idx = parseInt(data, 10) - 1;
					if (idx < allOptions.length) submitOption(idx);
					return;
				}
				if (matchesKey(data, Key.up)) {
					optionIndex = Math.max(0, optionIndex - 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) { submitOption(optionIndex); return; }
				if (matchesKey(data, Key.tab)) { enterEditMode(); return; }
				if (matchesKey(data, Key.escape)) { done(null); return; }
			}

			function render(width: number): string[] {
				if (cachedLines) return cachedLines;

				const lines: string[] = [];
				const add = (s: string): void => { lines.push(truncateToWidth(s, width)); };
				const contentWidth = Math.min(width - 4, 100);

				renderQuestionHeader(lines, add, theme, params, contentWidth, width);

				for (let i = 0; i < allOptions.length; i++) {
					const opt = allOptions[i];
					const selected = i === optionIndex;

					if (selected) {
						add(theme.fg("accent", "> ") + theme.fg("accent", `${i + 1}. ${opt.label}`));
					} else {
						add(`  ${theme.fg("text", `${i + 1}. ${opt.label}`)}`);
					}

					if (opt.description) {
						for (const dl of wrapTextWithAnsi(theme.fg("muted", `     ${opt.description}`), contentWidth)) {
							add(dl);
						}
					}

					if (selected && editing) {
						for (const line of editor.render(width - 6)) {
							add(`     ${line}`);
						}
					}
				}

				lines.push("");
				const hint = editing
					? " Enter to submit • Shift+Enter for newline • Esc to stop editing"
					: " ↑↓ navigate • Enter to submit • Tab to edit • 1-9 quick select • Esc to skip";
				add(theme.fg("dim", hint));
				add(theme.fg("accent", "─".repeat(width)));

				cachedLines = lines;
				return lines;
			}

			return {
				render,
				invalidate: () => { cachedLines = undefined; },
				handleInput,
			};
		},
	);
}
