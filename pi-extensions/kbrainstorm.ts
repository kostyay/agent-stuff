/**
 * kbrainstorm - Interactive brainstorming question tool
 *
 * Registers an `ask_question` tool the LLM calls for each brainstorming question.
 * Shows an interactive TUI with options list + freeform "Type something" fallback.
 * The answer flows back as a tool result so the agent can use it to inform the next question.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface OptionWithDesc {
	label: string;
	description?: string;
}

type DisplayOption = OptionWithDesc & { isOther?: boolean };

interface AskQuestionDetails {
	question: string;
	context?: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const AskQuestionParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	context: Type.Optional(Type.String({ description: "Additional context to help the user answer (shown below the question)" })),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Options for the user to choose from. Omit for open-ended questions." })),
});

export default function kbrainstorm(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_question",
		label: "Ask Question",
		description:
			"Ask the user a single question during brainstorming. Shows an interactive TUI. " +
			"Provide options for multiple-choice, or omit options for open-ended questions. " +
			"Use one call per question so each answer can inform the next question.",
		parameters: AskQuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: {
						question: params.question,
						context: params.context,
						options: [],
						answer: null,
					} as AskQuestionDetails,
				};
			}

			const hasOptions = params.options && params.options.length > 0;

			// If no options provided, show a simple freeform editor
			if (!hasOptions) {
				const result = await ctx.ui.custom<{ answer: string } | null>((tui, theme, _kb, done) => {
					let cachedLines: string[] | undefined;

					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);

					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (trimmed) {
							done({ answer: trimmed });
						}
					};

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function handleInput(data: string) {
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
						const add = (s: string) => lines.push(truncateToWidth(s, width));
						const contentWidth = Math.min(width - 4, 100);

						add(theme.fg("accent", "─".repeat(width)));
						// Wrap question text
						const wrappedQ = wrapTextWithAnsi(theme.fg("text", ` ${params.question}`), contentWidth);
						for (const line of wrappedQ) {
							add(line);
						}

						if (params.context) {
							lines.push("");
							const wrappedCtx = wrapTextWithAnsi(theme.fg("muted", `   ${params.context}`), contentWidth);
							for (const line of wrappedCtx) {
								add(line);
							}
						}

						lines.push("");
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

				if (!result) {
					return {
						content: [{ type: "text", text: "User skipped this question" }],
						details: { question: params.question, context: params.context, options: [], answer: null } as AskQuestionDetails,
					};
				}

				return {
					content: [{ type: "text", text: `User answered: ${result.answer}` }],
					details: {
						question: params.question,
						context: params.context,
						options: [],
						answer: result.answer,
						wasCustom: true,
					} as AskQuestionDetails,
				};
			}

			// Options mode: selected option is always in edit mode with pre-filled text.
			// Press Enter to submit as-is or after editing. Press 1-9 to quick-submit.
			// "Type something" starts with an empty editor.
			const allOptions: DisplayOption[] = [...params.options!, { label: "Type something.", isOther: true }];

			const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>(
				(tui, theme, _kb, done) => {
					let optionIndex = 0;
					let cachedLines: string[] | undefined;

					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);

					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (trimmed) {
							const sourceOpt = allOptions[optionIndex];
							const isOther = sourceOpt?.isOther === true;
							// If the answer matches the original option label exactly, treat as a selection
							const wasEdited = isOther || trimmed !== sourceOpt?.label;
							done({
								answer: trimmed,
								wasCustom: wasEdited,
								index: isOther ? undefined : optionIndex + 1,
							});
						}
					};

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function syncEditorToOption(index: number) {
						const opt = allOptions[index];
						if (opt.isOther) {
							editor.setText("");
						} else {
							editor.setText(opt.label);
						}
					}

					function submitOption(index: number) {
						const opt = allOptions[index];
						if (opt.isOther) return; // can't quick-submit "Type something"
						done({
							answer: opt.label,
							wasCustom: false,
							index: index + 1,
						});
					}

					// Start with first option pre-filled in editor
					syncEditorToOption(0);

					function handleInput(data: string) {
						// Numeric shortcuts: press 1-9 to immediately submit that option
						if (data.length === 1 && data >= "1" && data <= "9") {
							const idx = parseInt(data, 10) - 1;
							if (idx < allOptions.length) {
								submitOption(idx);
							}
							return;
						}

						if (matchesKey(data, Key.up)) {
							optionIndex = Math.max(0, optionIndex - 1);
							syncEditorToOption(optionIndex);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
							syncEditorToOption(optionIndex);
							refresh();
							return;
						}

						if (matchesKey(data, Key.escape)) {
							done(null);
							return;
						}

						// All other input (including Enter) goes to the editor
						editor.handleInput(data);
						refresh();
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const lines: string[] = [];
						const add = (s: string) => lines.push(truncateToWidth(s, width));
						const contentWidth = Math.min(width - 4, 100);

						add(theme.fg("accent", "─".repeat(width)));
						// Wrap question text
						const wrappedQ = wrapTextWithAnsi(theme.fg("text", ` ${params.question}`), contentWidth);
						for (const line of wrappedQ) {
							add(line);
						}

						if (params.context) {
							lines.push("");
							const wrappedCtx = wrapTextWithAnsi(theme.fg("muted", `   ${params.context}`), contentWidth);
							for (const line of wrappedCtx) {
								add(line);
							}
						}

						lines.push("");

						for (let i = 0; i < allOptions.length; i++) {
							const opt = allOptions[i];
							const selected = i === optionIndex;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";

							if (selected) {
								add(prefix + theme.fg("accent", `${i + 1}. ${opt.label}`));
								// Show inline editor directly below selected option
								for (const line of editor.render(width - 6)) {
									add(`     ${line}`);
								}
							} else {
								add(`  ${theme.fg("text", `${i + 1}. ${opt.label}`)}`);
							}

							if (opt.description && !selected) {
								add(`     ${theme.fg("muted", opt.description)}`);
							}
						}

						lines.push("");
						add(theme.fg("dim", " ↑↓ navigate • Enter to submit • 1-9 quick select • Esc to skip"));
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

			const simpleOptions = params.options!.map((o) => o.label);

			if (!result) {
				return {
					content: [{ type: "text", text: "User skipped this question" }],
					details: { question: params.question, context: params.context, options: simpleOptions, answer: null } as AskQuestionDetails,
				};
			}

			if (result.wasCustom) {
				return {
					content: [{ type: "text", text: `User wrote: ${result.answer}` }],
					details: {
						question: params.question,
						context: params.context,
						options: simpleOptions,
						answer: result.answer,
						wasCustom: true,
					} as AskQuestionDetails,
				};
			}

			return {
				content: [{ type: "text", text: `User selected: ${result.index}. ${result.answer}` }],
				details: {
					question: params.question,
					context: params.context,
					options: simpleOptions,
					answer: result.answer,
					wasCustom: false,
				} as AskQuestionDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("ask_question ")) + theme.fg("muted", args.question || "");
			if (args.context) {
				text += `\n${theme.fg("dim", `  ${args.context}`)}`;
			}
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length) {
				const labels = opts.map((o: OptionWithDesc) => o.label);
				const numbered = [...labels, "Type something."].map((o, i) => `${i + 1}. ${o}`);
				text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskQuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.answer === null) {
				return new Text(theme.fg("warning", "Skipped"), 0, 0);
			}

			if (details.wasCustom) {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", details.answer),
					0,
					0,
				);
			}
			const idx = details.options.indexOf(details.answer) + 1;
			const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
		},
	});
}
