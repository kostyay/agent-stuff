/**
 * Shared types for the subagent extension.
 *
 * Centralizes all interfaces and type aliases used across modules.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentScope } from "./agents.js";

/** Accumulated token usage and cost for a single agent run. */
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** Result of a single subagent invocation. */
export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "bundled" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	sessionId?: string;
}

/** Structured details attached to a subagent tool result. */
export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

/** Live progress emitted by a running subagent for the dashboard widget. */
export interface AgentProgress {
	toolCount: number;
	lastLine: string;
	contextTokens: number;
	elapsed: number;
}

/** A single entry in the agent's live log viewer. */
export type LogEntry =
	| { kind: "text"; line: string }
	| { kind: "toolCall"; name: string; args: Record<string, unknown> }
	| { kind: "toolOutput"; text: string }
	| { kind: "separator" };

/** Tracks a single running/completed agent for the dashboard widget. */
export interface RunState {
	id: number;
	agent: string;
	task: string;
	/** AI-generated short description of the task (3–6 words). */
	description?: string;
	status: "running" | "done" | "error" | "aborted";
	progress: AgentProgress;
	model?: string;
	mode: "single" | "parallel" | "chain";
	step?: number;
	/** Structured log entries for the live log viewer. */
	logEntries: LogEntry[];
	/** Partial line buffer for streaming text that hasn't hit a newline yet. */
	logPartial: string;
}

/** Persistent session record for conversation continuation. */
export interface SessionRecord {
	id: string;
	sessionFile: string;
	agentName: string;
	agentSource: "user" | "project" | "bundled";
	turnCount: number;
}

/** Display item for rendering assistant output. */
export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

/** Parsed segment from `/chain` or `/parallel` command input. */
export interface ParsedSegment {
	agent: string;
	task: string;
}

/** Result returned by the agent manager overlay. */
export type AgentManagerResult =
	| { action: "run"; agent: string; task: string }
	| { action: "chain"; agents: string[]; task: string }
	| { action: "parallel"; tasks: Array<{ agent: string; task: string }> }
	| undefined;

/** Callback for streaming partial results during agent execution. */
export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;
