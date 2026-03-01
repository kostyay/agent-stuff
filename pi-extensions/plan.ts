/**
 * /plan - One-shot planning mode
 *
 * Usage: /plan <prompt>
 *
 * Enters a read-only planning flow:
 * 1. Restricts tools to read-only (read, bash safe-only, grep, find, ls, ask_question)
 * 2. Agent explores codebase, asks clarifying questions via ask_question
 * 3. Agent presents plan in sections, validates each with ask_question
 * 4. On completion, asks user where to save and whether to execute
 *
 * Depends on kbrainstorm extension for the ask_question tool.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Safe command filter (from plan-mode example) ─────────────────────────

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*exa\b/,
];

function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

// ── Planning prompt ──────────────────────────────────────────────────────

function buildPlanPrompt(userPrompt: string): string {
	return `[PLAN MODE ACTIVE - READ ONLY]

You are in planning mode. You MUST NOT make any file changes.
Your tools are restricted to read-only operations.

Your task: ${userPrompt}

Follow this process:
1. Explore the codebase to understand the current state relevant to the task (read files, search, grep, etc.)
2. Ask clarifying questions using ask_question (one question at a time, prefer multiple choice when possible)
3. Once you understand the task fully, present your plan in sections of 200-300 words
4. After each section, use ask_question to check if it looks right
5. When the plan is complete, output the final consolidated plan

The plan should include:
- What changes are needed and where (specific files and functions)
- Step-by-step implementation order
- Key decisions and trade-offs considered
- Edge cases and error handling to address

Important:
- Do NOT attempt to make any changes - only observe, analyze, and plan
- Use ask_question for ALL questions to the user (never ask in plain text)
- Be thorough in exploration before proposing the plan
- Keep each plan section focused and concise`;
}

// ── Extension ────────────────────────────────────────────────────────────

const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "ask_question"];
const ENTRY_TYPE = "plan-mode-state";

interface PlanState {
	active: boolean;
	prompt: string;
	originalTools: string[];
}

export default function planExtension(pi: ExtensionAPI) {
	let planActive = false;
	let planPrompt = "";
	let originalTools: string[] = [];

	function updateStatus(ctx: ExtensionContext) {
		if (planActive) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "📋 plan"));
		} else {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("success", "🤖 agent"));
		}
	}

	function enterPlanMode(ctx: ExtensionContext) {
		originalTools = pi.getActiveTools();
		planActive = true;
		pi.setActiveTools(PLAN_TOOLS);
		updateStatus(ctx);
		persistState();
	}

	function exitPlanMode(ctx: ExtensionContext) {
		planActive = false;
		planPrompt = "";
		pi.setActiveTools(originalTools.length > 0 ? originalTools : ["read", "bash", "edit", "write"]);
		originalTools = [];
		updateStatus(ctx);
		persistState();
	}

	function persistState() {
		pi.appendEntry(ENTRY_TYPE, {
			active: planActive,
			prompt: planPrompt,
			originalTools,
		} as PlanState);
	}

	// ── /plan command ────────────────────────────────────────────────────

	pi.registerCommand("plan", {
		description: "Enter planning mode: /plan <describe what you want to do>",
		handler: async (args, ctx) => {
			const prompt = args?.trim();
			if (!prompt) {
				ctx.ui.notify("Usage: /plan <describe what you want to do>", "warning");
				return;
			}

			if (planActive) {
				ctx.ui.notify("Already in plan mode. Finish or cancel the current plan first.", "warning");
				return;
			}

			planPrompt = prompt;
			enterPlanMode(ctx);
			ctx.ui.notify("Entered plan mode (read-only). Planning...", "info");

			// Send the planning prompt as a user message to kick off the agent
			pi.sendUserMessage(buildPlanPrompt(prompt));
		},
	});

	// ── Ctrl+Tab shortcut to toggle modes ────────────────────────────────

	pi.registerShortcut("shift+tab", {
		description: "Toggle between agent and plan mode",
		handler: async (ctx) => {
			if (planActive) {
				// Switch back to agent mode immediately
				exitPlanMode(ctx);
				ctx.ui.notify("Switched to agent mode.", "info");
				return;
			}

			// Entering plan mode — ask for a prompt
			const prompt = await ctx.ui.input("What do you want to plan?", "");
			if (!prompt?.trim()) return;

			planPrompt = prompt.trim();
			enterPlanMode(ctx);
			ctx.ui.notify("Entered plan mode (read-only). Planning...", "info");
			pi.sendUserMessage(buildPlanPrompt(planPrompt));
		},
	});

	// ── Block unsafe bash commands ───────────────────────────────────────

	pi.on("tool_call", async (event) => {
		if (!planActive || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not in read-only allowlist).\nCommand: ${command}`,
			};
		}
	});

	// ── Filter out plan mode context messages when not planning ──────────

	pi.on("context", async (event) => {
		if (planActive) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE"),
					);
				}
				return true;
			}),
		};
	});

	// ── Handle plan completion ───────────────────────────────────────────

	pi.on("agent_end", async (event, ctx) => {
		if (!planActive || !ctx.hasUI) return;

		// Extract the plan from the last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		const planText = lastAssistant ? getTextContent(lastAssistant) : "";

		// Ask what to do next
		const action = await ctx.ui.select("Plan complete — what would you like to do?", [
			"Save plan to file",
			"Save plan and execute it",
			"Continue refining (stay in plan mode)",
			"Discard and exit plan mode",
		]);

		if (!action || action === "Discard and exit plan mode") {
			exitPlanMode(ctx);
			ctx.ui.notify("Plan mode exited.", "info");
			return;
		}

		if (action === "Continue refining (stay in plan mode)") {
			const refinement = await ctx.ui.editor("What should be refined?", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim());
			}
			return;
		}

		// Save flow
		const defaultPath = `docs/plans/${new Date().toISOString().slice(0, 10)}-plan.md`;
		const savePath = await ctx.ui.input("Save plan to:", defaultPath);

		if (savePath?.trim()) {
			const path = savePath.trim();
			// Write the plan file via the extension (not the agent, since we're in read-only mode)
			try {
				const { writeFile, mkdir } = await import("node:fs/promises");
				const { dirname } = await import("node:path");
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, planText, "utf-8");
				ctx.ui.notify(`Plan saved to ${path}`, "success");
			} catch (err: any) {
				ctx.ui.notify(`Failed to save plan: ${err.message}`, "error");
			}
		}

		if (action === "Save plan and execute it") {
			exitPlanMode(ctx);
			const execPrompt = savePath?.trim()
				? `Execute the plan saved at ${savePath.trim()}. Read it first, then implement it step by step.`
				: `Execute the following plan step by step:\n\n${planText}`;
			pi.sendUserMessage(execPrompt);
		} else {
			// Just saved
			exitPlanMode(ctx);
			ctx.ui.notify("Plan mode exited.", "info");
		}
	});

	// ── Restore state on session start/resume ────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();

		const stateEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === ENTRY_TYPE)
			.pop() as { data?: PlanState } | undefined;

		if (stateEntry?.data) {
			planActive = stateEntry.data.active ?? false;
			planPrompt = stateEntry.data.prompt ?? "";
			originalTools = stateEntry.data.originalTools ?? [];

			if (planActive) {
				pi.setActiveTools(PLAN_TOOLS);
			}
		}

		updateStatus(ctx);
	});
}
