/**
 * Subagent Stats Reporter
 *
 * Tiny extension loaded into child pi processes (via `-e`) that reports
 * real-time stats back to the parent over the UDP control channel.
 *
 * Sends: text_delta, tool_start, tool_end, usage, agent_done
 * Reads PI_CONTROL_PORT and PI_CONTROL_ID from environment.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { sendControlMessage } from "../../lib/control-channel.ts";

export default function statsReporterExtension(pi: ExtensionAPI): void {
	/** Accumulated text chunks for computing "last line" in the parent. */
	let textChunks: string[] = [];

	pi.on("message_update", async (event) => {
		const delta = event.assistantMessageEvent;
		if (delta?.type === "text_delta" && typeof delta.delta === "string") {
			textChunks.push(delta.delta);
			const full = textChunks.join("");
			const lastLine = full.split("\n").filter((l: string) => l.trim()).pop() ?? "";
			sendControlMessage({ type: "text_delta", lastLine });
		}
	});

	pi.on("tool_execution_start", async (event) => {
		sendControlMessage({
			type: "tool_start",
			toolName: event.toolName ?? "unknown",
		});
	});

	pi.on("tool_execution_end", async (event) => {
		sendControlMessage({
			type: "tool_end",
			toolName: event.toolName ?? "unknown",
			isError: event.isError ?? false,
		});
	});

	pi.on("message_end", async (event) => {
		const msg = event.message;
		if (msg?.role === "assistant") {
			const usage = msg.usage;
			sendControlMessage({
				type: "usage",
				input: usage?.input ?? 0,
				output: usage?.output ?? 0,
				cacheRead: usage?.cacheRead ?? 0,
				cacheWrite: usage?.cacheWrite ?? 0,
				cost: usage?.cost?.total ?? 0,
				contextTokens: usage?.totalTokens ?? 0,
				model: msg.model,
				stopReason: msg.stopReason,
				errorMessage: msg.errorMessage,
			});
			// Reset text accumulator for next turn
			textChunks = [];
		}
	});

	pi.on("agent_end", async () => {
		sendControlMessage({ type: "agent_done" });
	});
}
