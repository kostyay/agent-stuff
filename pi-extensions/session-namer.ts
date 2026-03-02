/**
 * Session Namer
 *
 * Auto-generates a short descriptive session name using Haiku after the
 * first agent response. Re-generates on compaction or via /session-name-refresh.
 * Appends a mode emoji (📋 plan, 🧠 ask) based on the most recent non-agent mode.
 *
 * All AI calls run in the background — never blocks the agent loop.
 */

import { complete, getModel } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Model ────────────────────────────────────────────────────────────────

const HAIKU = getModel("anthropic", "claude-haiku-4-5");

// ── Prompt ───────────────────────────────────────────────────────────────

const NAME_PROMPT = `Generate a short descriptive name (3-6 words) for this coding session based on the conversation below.
Rules:
- Capture the primary task or topic
- Use a concise phrase (not a full sentence)
- No quotes, no punctuation at the end
- Lowercase start unless a proper noun

Conversation:
`;

/** Max chars of conversation context sent to Haiku. */
const MAX_CONTEXT_CHARS = 2000;

// ── Mode tracking ────────────────────────────────────────────────────────

type TrackedMode = "plan" | "ask";

const MODE_EMOJI: Record<TrackedMode, string> = {
	plan: "📋",
	ask: "🧠",
};

const PLAN_ASK_ENTRY_TYPE = "plan-ask-mode-state";

// ── Extension ────────────────────────────────────────────────────────────

/** Session Namer extension — auto-names sessions via Haiku. */
export default function sessionNamerExtension(pi: ExtensionAPI) {
	let agentEndCount = 0;
	let generating = false;
	let lastNonAgentMode: TrackedMode | null = null;
	let baseName: string | null = null;

	// ── Helpers ──────────────────────────────────────────────────────

	/** Extract conversation text from the current branch for the prompt. */
	function collectContext(ctx: ExtensionContext): string {
		const parts: string[] = [];
		let chars = 0;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "user" && msg.role !== "assistant") continue;

			let text = "";
			if (typeof msg.content === "string") {
				text = msg.content;
			} else if (Array.isArray(msg.content)) {
				text = msg.content
					.filter((b: { type: string }) => b.type === "text")
					.map((b: { type: string; text?: string }) => b.text ?? "")
					.join("\n");
			}

			if (!text) continue;

			const remaining = MAX_CONTEXT_CHARS - chars;
			if (remaining <= 0) break;

			const chunk = text.length > remaining ? text.slice(0, remaining) : text;
			parts.push(`${msg.role}: ${chunk}`);
			chars += chunk.length;
		}

		return parts.join("\n\n");
	}

	/** Scan session entries for plan-ask mode state and update lastNonAgentMode. */
	function syncModeFromSession(ctx: ExtensionContext): void {
		for (const entry of ctx.sessionManager.getEntries()) {
			const e = entry as { type: string; customType?: string; data?: { mode?: string } };
			if (e.type !== "custom" || e.customType !== PLAN_ASK_ENTRY_TYPE) continue;
			const mode = e.data?.mode;
			if (mode === "plan") lastNonAgentMode = "plan";
			else if (mode === "ask") lastNonAgentMode = "ask";
		}
	}

	/** Build the full session name with mode emoji suffix. */
	function buildFullName(): string {
		if (!baseName) return "";
		return lastNonAgentMode ? `${baseName} ${MODE_EMOJI[lastNonAgentMode]}` : baseName;
	}

	/** Apply the current name (base + mode tag) to the session. */
	function applyName(): void {
		const name = buildFullName();
		if (name) pi.setSessionName(name);
	}

	/** Call Haiku to generate a name from the given context text. */
	async function callHaiku(contextText: string, ctx: ExtensionContext): Promise<string | undefined> {
		if (!HAIKU) return undefined;

		const apiKey = await ctx.modelRegistry.getApiKey(HAIKU);
		if (!apiKey) return undefined;

		const response = await complete(HAIKU, {
			messages: [{
				role: "user" as const,
				content: [{ type: "text" as const, text: NAME_PROMPT + contextText }],
				timestamp: Date.now(),
			}],
		}, { apiKey });

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim()
			.replace(/^["']|["']$/g, "")
			.split("\n")[0]
			?.trim();

		return text || undefined;
	}

	/**
	 * Fire-and-forget name generation.
	 *
	 * Collects context, calls Haiku, and sets the session name.
	 * Silently catches errors — naming is best-effort.
	 */
	function generateInBackground(ctx: ExtensionContext, contextOverride?: string): void {
		if (generating) return;
		generating = true;

		const contextText = contextOverride ?? collectContext(ctx);
		if (!contextText) {
			generating = false;
			return;
		}

		callHaiku(contextText, ctx)
			.then((name) => {
				if (name) {
					baseName = name;
					applyName();
				}
			})
			.catch(() => { /* silent — best effort */ })
			.finally(() => { generating = false; });
	}

	// ── Events ───────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		agentEndCount = 0;
		generating = false;
		lastNonAgentMode = null;
		baseName = null;

		// Restore mode history
		syncModeFromSession(ctx);

		// Restore existing name
		const existing = pi.getSessionName();
		if (existing) {
			// Strip emoji suffix to get base name
			const stripped = existing.replace(/\s*[📋🧠]+\s*$/, "").trim();
			if (stripped) baseName = stripped;
		}

		// Count past agent turns for agentEndCount
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			if (entry.message.role === "assistant") agentEndCount++;
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		agentEndCount++;

		// Sync mode in case plan-ask changed during this agent run
		syncModeFromSession(ctx);

		// Re-apply name with updated mode tag (cheap, no AI call)
		if (baseName) applyName();

		// Generate name after first agent response only
		if (agentEndCount === 1) {
			generateInBackground(ctx);
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		// Use compaction summary as context — already a condensed description
		const entries = ctx.sessionManager.getBranch();
		const compaction = entries
			.filter((e): e is { type: "compaction"; summary: string } & typeof e =>
				e.type === "compaction" && "summary" in e)
			.pop();

		const summary = compaction?.summary;
		if (summary) {
			generateInBackground(ctx, summary);
		}
	});

	pi.on("session_switch", async (event) => {
		if (event.reason === "new") {
			agentEndCount = 0;
			generating = false;
			lastNonAgentMode = null;
			baseName = null;
		}
	});

	// ── Command ──────────────────────────────────────────────────────

	pi.registerCommand("session-name-refresh", {
		description: "Re-generate the session name using AI",
		handler: async (_args, ctx) => {
			if (generating) {
				ctx.ui.notify("Name generation already in progress", "info");
				return;
			}

			ctx.ui.notify("Regenerating session name…", "info");
			generateInBackground(ctx);
		},
	});
}
