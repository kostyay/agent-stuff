/**
 * Plan & Ask Mode Extension
 *
 * Manages three agent modes via Shift+Tab rotation: agent → ask → plan → agent.
 *
 * **Shift+Tab** — Rotates between modes instantly. Tools are restricted
 * to read-only in ask/plan modes and the appropriate system prompt is
 * injected via `before_agent_start`.
 *
 * **`/plan <prompt>`** — One-shot: enters plan mode and sends the prompt.
 * **`/ask <question>`** — One-shot: enters ask mode and sends the question.
 *
 * Modes:
 * - **Agent** — Full tool access, normal operation.
 * - **Ask** — Read-only. Agent answers questions thoroughly with code refs.
 * - **Plan** — Read-only. Agent explores, asks clarifying questions, builds a plan.
 *   On completion, offers save/execute/refine options.
 *
 * Depends on kbrainstorm extension for the ask_question tool.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@mariozechner/pi-coding-agent";

// ── Types ────────────────────────────────────────────────────────────────

type Mode = "agent" | "ask" | "plan";

/** Mode constants to avoid string literals throughout the file. */
const AGENT: Mode = "agent";
const ASK: Mode = "ask";
const PLAN: Mode = "plan";

interface ModeState {
	mode: Mode;
	prompt: string;
	originalTools: string[];
}

// ── Safe command filter ──────────────────────────────────────────────────

const DESTRUCTIVE_PATTERNS: RegExp[] = [
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

const SAFE_PATTERNS: RegExp[] = [
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

/** Check whether a bash command is safe for read-only modes. */
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

/** Check whether a message contains a mode marker string. */
function containsModeMarker(content: unknown, marker: string): boolean {
	if (typeof content === "string") {
		return content.includes(marker);
	}
	if (Array.isArray(content)) {
		return content.some(
			(c) => c.type === "text" && (c as TextContent).text?.includes(marker),
		);
	}
	return false;
}

// ── Mode rotation ────────────────────────────────────────────────────────

const MODE_ROTATION: Mode[] = [AGENT, ASK, PLAN];

/** Return the next mode in the rotation cycle. */
function nextMode(current: Mode): Mode {
	const index = MODE_ROTATION.indexOf(current);
	return MODE_ROTATION[(index + 1) % MODE_ROTATION.length];
}

// ── System prompts ───────────────────────────────────────────────────────

const ASK_MODE_MARKER = "[ASK MODE ACTIVE";
const PLAN_MODE_MARKER = "[PLAN MODE ACTIVE";

const ASK_SYSTEM_PROMPT = `${ASK_MODE_MARKER} - READ ONLY]

You are in ask mode. You MUST NOT make any file changes.
Your tools are restricted to read-only operations.

Your role is to answer the user's questions about the codebase thoroughly:
1. Explore relevant files, search for patterns, read code to build understanding
2. Provide detailed answers with specific file paths and line references
3. Explain code patterns, architecture decisions, and data flow
4. When the answer spans multiple concepts, break it into clear sections

Important:
- Do NOT attempt to make any changes - only observe, analyze, and explain
- Cite specific files and code when answering
- If the question is ambiguous, use ask_question to clarify (one question at a time)
- Be thorough in exploration before answering`;

const PLAN_SYSTEM_PROMPT = `${PLAN_MODE_MARKER} - READ ONLY]

You are in planning mode. You MUST NOT make any file changes.
Your tools are restricted to read-only operations.

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

/** Map each mode to its system prompt (agent has none). */
const MODE_PROMPTS: Record<Mode, string | null> = {
	[AGENT]: null,
	[ASK]: ASK_SYSTEM_PROMPT,
	[PLAN]: PLAN_SYSTEM_PROMPT,
};

/** Mode markers to exclude from context per active mode. */
const EXCLUDE_MARKERS: Record<Mode, string[]> = {
	[AGENT]: [ASK_MODE_MARKER, PLAN_MODE_MARKER],
	[ASK]: [PLAN_MODE_MARKER],
	[PLAN]: [ASK_MODE_MARKER],
};

// ── Tool restrictions ────────────────────────────────────────────────────

/** Tools available in both ask and plan modes. */
const RESTRICTED_TOOLS: string[] = ["read", "bash", "grep", "find", "ls", "ask_question"];

/** Default tools restored when returning to agent mode. */
const DEFAULT_AGENT_TOOLS: string[] = ["read", "bash", "edit", "write"];

// ── Status display ───────────────────────────────────────────────────────

/** Display metadata for each mode — icon, label, and theme color. */
export interface ModeDisplay {
	icon: string;
	label: string;
	color: ThemeColor;
}

/** Per-mode display configuration used in the status bar and notifications. */
export const MODE_DISPLAY: Record<Mode, ModeDisplay> = {
	[AGENT]: { icon: "🤖", label: "agent", color: "success" },
	[ASK]: { icon: "❓", label: "ask", color: "accent" },
	[PLAN]: { icon: "📋", label: "plan", color: "warning" },
};

// ── Extension ────────────────────────────────────────────────────────────

const ENTRY_TYPE = "plan-ask-mode-state";

/** Plan & Ask mode extension — three-way mode rotation with read-only restrictions. */
export default function planAskExtension(pi: ExtensionAPI) {
	let mode: Mode = AGENT;
	let modePrompt = "";
	let originalTools: string[] = [];

	// ── Mode management ──────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext): void {
		const display = MODE_DISPLAY[mode];
		ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg(display.color, `${display.icon} ${display.label}`));
	}

	function setMode(newMode: Mode, ctx: ExtensionContext): void {
		if (newMode === mode) return;

		if (mode === AGENT) {
			originalTools = pi.getActiveTools();
		}

		mode = newMode;

		if (newMode === AGENT) {
			modePrompt = "";
			pi.setActiveTools(originalTools.length > 0 ? originalTools : DEFAULT_AGENT_TOOLS);
			originalTools = [];
		} else {
			pi.setActiveTools(RESTRICTED_TOOLS);
		}

		updateStatus(ctx);
		persistState();
	}

	function persistState(): void {
		pi.appendEntry(ENTRY_TYPE, {
			mode,
			prompt: modePrompt,
			originalTools,
		} as ModeState);
	}

	/** Build a user message with the mode's system prompt prepended. */
	function buildModePrompt(prompt: string, targetMode: Mode): string {
		const systemPrompt = MODE_PROMPTS[targetMode];
		if (!systemPrompt) return prompt;
		return `${systemPrompt}\n\nYour task: ${prompt}`;
	}

	// ── /plan command ────────────────────────────────────────────────

	pi.registerCommand("plan", {
		description: "Enter planning mode: /plan <describe what you want to do>",
		handler: async (args, ctx) => {
			const prompt = args?.trim();
			if (!prompt) {
				ctx.ui.notify("Usage: /plan <describe what you want to do>", "warning");
				return;
			}

			if (mode === PLAN) {
				ctx.ui.notify("Already in plan mode. Finish or cancel the current plan first.", "warning");
				return;
			}

			modePrompt = prompt;
			setMode(PLAN, ctx);
			ctx.ui.notify("Entered plan mode (read-only). Planning...", "info");
			pi.sendUserMessage(buildModePrompt(prompt, PLAN));
		},
	});

	// ── /ask command ─────────────────────────────────────────────────

	pi.registerCommand("ask", {
		description: "Enter ask mode: /ask <your question about the codebase>",
		handler: async (args, ctx) => {
			const question = args?.trim();
			if (!question) {
				ctx.ui.notify("Usage: /ask <your question about the codebase>", "warning");
				return;
			}

			if (mode === ASK) {
				// Already in ask mode — just send the question directly
				pi.sendUserMessage(question);
				return;
			}

			modePrompt = question;
			setMode(ASK, ctx);
			ctx.ui.notify("Entered ask mode (read-only). Answering...", "info");
			pi.sendUserMessage(buildModePrompt(question, ASK));
		},
	});

	// ── Shift+Tab shortcut to rotate modes ───────────────────────────

	pi.registerShortcut("shift+tab", {
		description: "Rotate between agent, ask, and plan modes",
		handler: async (ctx) => {
			const newMode = nextMode(mode);
			setMode(newMode, ctx);

			const display = MODE_DISPLAY[newMode];
			const suffix = newMode === AGENT ? "" : " (read-only)";
			ctx.ui.notify(`Switched to ${display.label} mode${suffix}.`, "info");
		},
	});

	// ── Inject system prompt for active mode ─────────────────────────

	pi.on("before_agent_start", async (event) => {
		const systemPrompt = MODE_PROMPTS[mode];
		if (!systemPrompt) return;

		return {
			systemPrompt: event.systemPrompt + "\n\n" + systemPrompt,
		};
	});

	// ── Block unsafe bash in restricted modes ────────────────────────

	pi.on("tool_call", async (event) => {
		if (mode === AGENT || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `${MODE_DISPLAY[mode].label} mode: command blocked (not in read-only allowlist).\nCommand: ${command}`,
			};
		}
	});

	// ── Filter mode-specific context messages ────────────────────────

	pi.on("context", async (event) => {
		const markers = EXCLUDE_MARKERS[mode];
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;
				return !markers.some((marker) => containsModeMarker(msg.content, marker));
			}),
		};
	});

	// ── Handle plan completion (ask mode has no special handling) ─────

	pi.on("agent_end", async (event, ctx) => {
		if (mode !== PLAN || !ctx.hasUI) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		const planText = lastAssistant ? getTextContent(lastAssistant) : "";

		const action = await ctx.ui.select("Plan complete - what would you like to do?", [
			"Create tickets with /kt-create",
			"Save plan to file",
			"Save plan and execute it",
			"Continue refining (stay in plan mode)",
			"Discard and exit plan mode",
		]);

		if (!action || action === "Discard and exit plan mode") {
			setMode(AGENT, ctx);
			ctx.ui.notify("Plan mode exited.", "info");
			return;
		}

		if (action === "Create tickets with /kt-create") {
			setMode(AGENT, ctx);
			pi.sendUserMessage("/kt-create");
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
			try {
				const { writeFile, mkdir } = await import("node:fs/promises");
				const { dirname } = await import("node:path");
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, planText, "utf-8");
				ctx.ui.notify(`Plan saved to ${path}`, "info");
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to save plan: ${message}`, "error");
			}
		}

		if (action === "Save plan and execute it") {
			setMode(AGENT, ctx);
			const execPrompt = savePath?.trim()
				? `Execute the plan saved at ${savePath.trim()}. Read it first, then implement it step by step.`
				: `Execute the following plan step by step:\n\n${planText}`;
			pi.sendUserMessage(execPrompt);
		} else {
			setMode(AGENT, ctx);
			ctx.ui.notify("Plan mode exited.", "info");
		}
	});

	// ── Restore state on session start/resume ────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();

		const stateEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === ENTRY_TYPE)
			.pop() as { data?: ModeState } | undefined;

		if (stateEntry?.data) {
			mode = stateEntry.data.mode ?? AGENT;
			modePrompt = stateEntry.data.prompt ?? "";
			originalTools = stateEntry.data.originalTools ?? [];

			if (mode !== AGENT) {
				pi.setActiveTools(RESTRICTED_TOOLS);
			}
		}

		updateStatus(ctx);
	});
}
