/**
 * Session Namer
 *
 * Auto-generates a short descriptive session name using Haiku after the
 * first user request. Re-generates on compaction or via /session-name-refresh.
 * Appends a mode emoji (📋 plan, 🧠 ask) based on the most recent non-agent mode.
 *
 * All AI calls run in the background — never blocks the agent loop.
 */

import { complete, getModel } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { sendControlMessage } from "../lib/control-channel.ts";

// ── Constants ────────────────────────────────────────────────────────────

const HAIKU = getModel("anthropic", "claude-haiku-4-5");

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

/** Matches paired XML-style tags with content (e.g. `<skill>…</skill>`). */
const TAG_BLOCK_RE = /<\/?[a-z_-]+(?:\s[^>]*)?>[\s\S]*?<\/[a-z_-]+>/gi;

/** Matches lone/unpaired XML-style tags. */
const LONE_TAG_RE = /<\/?[a-z_-]+(?:\s[^>]*)?>/gi;

/** Matches trailing mode emoji suffixes on persisted names. */
const EMOJI_SUFFIX_RE = /\s*[📋🧠]+\s*$/;

const PLAN_ASK_ENTRY_TYPE = "plan-ask-mode-state";

/**
 * Custom entry type that pins the session name.
 * Any extension can write `pi.appendEntry("session-name-pin", { name })` to
 * claim the session name. Session-namer will not overwrite a pinned name.
 */
const SESSION_NAME_PIN_TYPE = "session-name-pin";

type TrackedMode = "plan" | "ask";

const MODE_EMOJI: Record<TrackedMode, string> = {
	plan: "📋",
	ask: "🧠",
};

// ── Helpers ──────────────────────────────────────────────────────────────

/** Remove XML tags leaked from skill expansion and collapse whitespace. */
function stripTags(text: string): string {
	return text.replace(TAG_BLOCK_RE, " ").replace(LONE_TAG_RE, " ").replace(/\s{2,}/g, " ").trim();
}

/** Extract plain text from a message content field. */
function extractText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n");
}

/** Check whether any extension has pinned the session name. */
function hasPinnedName(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getEntries().some((entry) => {
		const e = entry as { type: string; customType?: string };
		return e.type === "custom" && e.customType === SESSION_NAME_PIN_TYPE;
	});
}

/** Count user messages on the current branch. */
function countUserTurns(ctx: ExtensionContext): number {
	return ctx.sessionManager.getBranch()
		.filter((entry) => entry.type === "message" && entry.message.role === "user")
		.length;
}

// ── Extension ────────────────────────────────────────────────────────────

/** Session Namer extension — auto-names sessions via Haiku. */
export default function sessionNamerExtension(pi: ExtensionAPI): void {
	let userTurnCount = 0;
	let generating = false;
	let lastNonAgentMode: TrackedMode | null = null;
	let baseName: string | null = null;
	let pinned = false;

	/** Reset all state to initial values. */
	function resetState(): void {
		userTurnCount = 0;
		generating = false;
		lastNonAgentMode = null;
		baseName = null;
		pinned = false;
	}

	/** Restore name, mode, and turn count from a (re)loaded session. */
	function restoreFromSession(ctx: ExtensionContext): void {
		syncModeFromSession(ctx);
		pinned = hasPinnedName(ctx);

		const existing = pi.getSessionName();
		if (existing) {
			const stripped = existing.replace(EMOJI_SUFFIX_RE, "").trim();
			if (stripped) baseName = stripped;
		}

		userTurnCount = countUserTurns(ctx);
	}

	/** Scan session entries for plan-ask mode state. */
	function syncModeFromSession(ctx: ExtensionContext): void {
		const modeEntries = ctx.sessionManager.getEntries()
			.filter((entry) => {
				const e = entry as { type: string; customType?: string };
				return e.type === "custom" && e.customType === PLAN_ASK_ENTRY_TYPE;
			}) as Array<{ data?: { mode?: string } }>;

		const last = modeEntries.at(-1);
		const mode = last?.data?.mode;
		if (mode === "plan" || mode === "ask") lastNonAgentMode = mode;
	}

	/** Apply the current name (base + mode emoji) to the session. Skips if pinned. */
	function applyName(): void {
		if (!baseName || pinned) return;
		const name = lastNonAgentMode ? `${baseName} ${MODE_EMOJI[lastNonAgentMode]}` : baseName;
		pi.setSessionName(name);
		sendControlMessage({ type: "session_name", name: baseName });
	}

	/** Collect conversation text from the current branch, stripped and truncated. */
	function collectContext(ctx: ExtensionContext): string {
		const parts: string[] = [];
		let chars = 0;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const { role } = entry.message;
			if (role !== "user" && role !== "assistant") continue;

			const text = extractText(entry.message.content);
			if (!text) continue;

			const remaining = MAX_CONTEXT_CHARS - chars;
			if (remaining <= 0) break;

			const chunk = text.slice(0, remaining);
			parts.push(`${role}: ${chunk}`);
			chars += chunk.length;
		}

		return stripTags(parts.join("\n\n"));
	}

	/** Call Haiku to generate a session name from context text. */
	async function callHaiku(contextText: string, ctx: ExtensionContext): Promise<string | undefined> {
		if (!HAIKU) return undefined;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(HAIKU);
		if (!auth.ok) return undefined;

		const response = await complete(HAIKU, {
			messages: [{
				role: "user" as const,
				content: [{ type: "text" as const, text: NAME_PROMPT + contextText }],
				timestamp: Date.now(),
			}],
		}, { apiKey: auth.apiKey, headers: auth.headers });

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
	 * Silently catches errors — naming is best-effort.
	 */
	function generateInBackground(ctx: ExtensionContext, contextOverride?: string): void {
		if (generating || pinned) return;
		generating = true;

		const contextText = stripTags(contextOverride ?? collectContext(ctx));
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
			.catch(() => {})
			.finally(() => { generating = false; });
	}

	// ── Events ───────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		resetState();
		restoreFromSession(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		userTurnCount++;
		if (userTurnCount === 1 && event.prompt) {
			generateInBackground(ctx, `user: ${event.prompt}`);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		syncModeFromSession(ctx);
		if (baseName) applyName();
	});

	pi.on("session_compact", async (_event, ctx) => {
		const compaction = ctx.sessionManager.getBranch()
			.filter((e) => e.type === "compaction" && "summary" in e)
			.pop() as { summary: string } | undefined;

		if (compaction?.summary) {
			generateInBackground(ctx, compaction.summary);
		}
	});

	pi.on("session_switch", async (event, ctx) => {
		resetState();
		if (event.reason === "new") return;

		// Resume — restore state from the switched-to session
		restoreFromSession(ctx);
		if (baseName) applyName();
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
