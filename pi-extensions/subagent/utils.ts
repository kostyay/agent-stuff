/**
 * Utility functions for the subagent extension.
 *
 * Pure helpers for result inspection, message extraction,
 * concurrency control, session management, and command parsing.
 */

import type { Message } from "@mariozechner/pi-ai";
import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DisplayItem, ParsedSegment, SessionRecord, SingleResult, UsageStats } from "./types.js";

/** Resolve session directory using the same env var as pi core (PI_CODING_AGENT_DIR). */
export function getSessionDir(): string {
	return path.join(getAgentDir(), "sessions", "subagents");
}

/** Zero-initialized usage stats, used as default for new/placeholder results. */
export function zeroUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Return a themed ✓/✗/⏳ icon based on the result's exit code. */
export function resultIcon(
	r: SingleResult,
	themeFg: (color: ThemeColor, text: string) => string,
): string {
	if (r.exitCode === -1) return themeFg("warning", "⏳");
	return r.exitCode === 0 ? themeFg("success", "✓") : themeFg("error", "✗");
}

/** Check whether a completed result represents an error. */
export function isAgentError(r: SingleResult): boolean {
	return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
}

/** Extract the best available error message from a result. */
export function getErrorMessage(r: SingleResult): string {
	return r.errorMessage || r.stderr || getFinalOutput(r.messages) || "(no output)";
}

/** Aggregate usage stats across multiple results. */
export function aggregateUsage(results: SingleResult[]): Omit<UsageStats, "contextTokens"> {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

/** Extract the last assistant text block from a message array. */
export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/** Collect all assistant text blocks and tool calls for display rendering. */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

/** Append agent output JSONL paths to a result string so the parent can read full details. */
export function appendOutputPaths(
	text: string,
	results: SingleResult[],
	sessions: Map<string, SessionRecord>,
): string {
	const entries = results
		.filter((r) => r.sessionId && sessions.has(r.sessionId))
		.map((r) => ({ agent: r.agent, file: sessions.get(r.sessionId!)!.sessionFile }));
	if (entries.length === 0) return text;
	if (entries.length === 1) {
		return `${text}\n\nAgent output log (JSONL): ${entries[0].file}`;
	}
	const lines = entries.map((e) => `  ${e.agent}: ${e.file}`);
	return `${text}\n\nAgent output logs (JSONL):\n${lines.join("\n")}`;
}

/** Run async tasks over an array with a bounded number of concurrent workers. */
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = Array.from({ length: limit }, async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

/** Write a system prompt to a temp file for passing to `pi --append-system-prompt`. */
export function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

/** Create the session directory if it doesn't exist. */
export function ensureSessionDir(): void {
	fs.mkdirSync(getSessionDir(), { recursive: true });
}

/**
 * Parse `/chain` and `/parallel` command syntax into agent+task segments.
 *
 * Supported formats:
 *   agent1 "task one" -> agent2 "task two"
 *   agent1 'task one' -> agent2 'task two'
 *   agent1 unquoted task text -> agent2 more text
 *   agent1 (agent name only, no task)
 *
 * Returns null if input is empty/undefined.
 */
export function parseAgentSegments(input: string | undefined): ParsedSegment[] | null {
	const raw = input?.trim();
	if (!raw) return null;

	const parts = raw.split(/\s*->\s*/);
	const segments: ParsedSegment[] = [];

	for (const part of parts) {
		const trimmed = part.trim();
		if (!trimmed) continue;

		// Match: agentName "quoted task" or agentName 'quoted task'
		const quotedMatch = trimmed.match(/^(\S+)\s+(?:"([^"]+)"|'([^']+)')$/);
		if (quotedMatch) {
			segments.push({ agent: quotedMatch[1], task: quotedMatch[2] ?? quotedMatch[3] });
			continue;
		}

		// Match: agentName unquoted rest of text
		const unquotedMatch = trimmed.match(/^(\S+)\s+(.+)$/);
		if (unquotedMatch) {
			segments.push({ agent: unquotedMatch[1], task: unquotedMatch[2] });
		} else {
			// Agent name only — no task provided (no spaces means single token)
			segments.push({ agent: trimmed, task: "" });
		}
	}

	return segments.length > 0 ? segments : null;
}
