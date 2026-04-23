/**
 * kbrainstorm - Interactive brainstorming question tool
 *
 * Registers an `ask_question` tool the LLM calls for each brainstorming question.
 * Delegates TUI rendering to lib/ask-question-ui for reusability.
 * The answer flows back as a tool result so the agent can use it to inform the next question.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

import { showAskQuestion, type AskQuestionDetails, type OptionWithDesc } from "./lib/ask-question-ui.ts";

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const AskQuestionParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	context: Type.Optional(Type.String({ description: "Additional context to help the user answer (shown below the question)" })),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Options for the user to choose from. Omit for open-ended questions." })),
});

export default function kbrainstorm(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_question",
		label: "Ask Question",
		description:
			"Ask the user a single question during brainstorming. Shows an interactive TUI. " +
			"Provide options for multiple-choice, or omit options for open-ended questions. " +
			"Use one call per question so each answer can inform the next question.",
		parameters: AskQuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const optionLabels = params.options?.map((o) => o.label) ?? [];

			function makeResult(text: string, answer: string | null, wasCustom?: boolean): {
				content: Array<{ type: "text"; text: string }>;
				details: AskQuestionDetails;
			} {
				return {
					content: [{ type: "text", text }],
					details: { question: params.question, context: params.context, options: optionLabels, answer, wasCustom },
				};
			}

			if (!ctx.hasUI) {
				return makeResult("Error: UI not available (running in non-interactive mode)", null);
			}

			const result = await showAskQuestion(
				ctx.ui,
				() => pi.events.emit("waiting_for_input", { question: params.question }),
				params,
			);

			if (!result) {
				return makeResult("User skipped this question", null);
			}

			if (result.wasCustom) {
				const verb = optionLabels.length > 0 ? "wrote" : "answered";
				return makeResult(`User ${verb}: ${result.answer}`, result.answer, true);
			}

			return makeResult(`User selected: ${result.index}. ${result.answer}`, result.answer, false);
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
