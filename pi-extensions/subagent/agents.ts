/**
 * Agent discovery and configuration
 */

import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

/** Which agent directories to search: user-level, project-level, or both. */
export type AgentScope = "user" | "project" | "both";

/** Origin of an agent definition: user-level, project-level, or built-in. */
export type AgentSource = "user" | "project" | "bundled";

/** Parsed agent definition from a markdown file with YAML frontmatter. */
export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

/** Result of scanning agent directories, including the resolved project agents path. */
export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/** Read all `.md` files in a directory and parse them into agent configs. */
function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

/** Check if a path exists and is a directory (returns false on error). */
function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Walk up from `cwd` to find the nearest `.pi/agents/` directory. */
function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/** Discover agents from user, project, and/or bundled directories based on scope. */
export function discoverAgents(cwd: string, scope: AgentScope, bundledDir?: string): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const bundledAgents = bundledDir ? loadAgentsFromDir(bundledDir, "bundled") : [];
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	// Bundled first (lowest priority), then user, then project (highest priority).
	const agentMap = new Map<string, AgentConfig>();
	for (const agent of bundledAgents) agentMap.set(agent.name, agent);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

/** Format a list of agents as a human-readable string, truncating after `maxItems`. */
export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}

/**
 * Update the model field in an agent's frontmatter and write back to disk.
 * Resolves symlinks before writing so the actual target file is updated.
 */
export function updateAgentModel(agent: AgentConfig, newModel: string): void {
	const realPath = fs.realpathSync(agent.filePath);
	const content = fs.readFileSync(realPath, "utf-8");
	const modelLineRegex = /^model:\s*.+$/m;

	let updated: string;
	if (modelLineRegex.test(content)) {
		updated = content.replace(modelLineRegex, `model: ${newModel}`);
	} else {
		// Insert model line after the last frontmatter field (before closing ---)
		updated = content.replace(/^(---\n[\s\S]*?)(\n---)/m, `$1\nmodel: ${newModel}$2`);
	}

	fs.writeFileSync(realPath, updated, "utf-8");
	agent.model = newModel;
}

// ── Teams ────────────────────────────────────────

/** Map of team name → array of agent names belonging to that team. */
export interface TeamConfig {
	[teamName: string]: string[];
}

/** Parse a minimal teams.yaml into a team name → agent names mapping. */
function parseTeamsYaml(raw: string): TeamConfig {
	const teams: TeamConfig = {};
	let current: string | null = null;
	for (const line of raw.split("\n")) {
		const teamMatch = line.match(/^(\S[^:]*):$/);
		if (teamMatch) {
			current = teamMatch[1].trim();
			teams[current] = [];
			continue;
		}
		const itemMatch = line.match(/^\s+-\s+(.+)$/);
		if (itemMatch && current) {
			teams[current].push(itemMatch[1].trim());
		}
	}
	return teams;
}

/**
 * Load team definitions from teams.yaml in user and/or project agent directories.
 * Project-level teams override user-level teams with the same name.
 */
export function loadTeams(projectAgentsDir: string | null, scope: AgentScope): TeamConfig {
	const merged: TeamConfig = {};

	if (scope !== "project") {
		const userPath = path.join(getAgentDir(), "agents", "teams.yaml");
		if (fs.existsSync(userPath)) {
			try {
				Object.assign(merged, parseTeamsYaml(fs.readFileSync(userPath, "utf-8")));
			} catch { /* skip malformed */ }
		}
	}

	if (scope !== "user" && projectAgentsDir) {
		const projectPath = path.join(projectAgentsDir, "teams.yaml");
		if (fs.existsSync(projectPath)) {
			try {
				Object.assign(merged, parseTeamsYaml(fs.readFileSync(projectPath, "utf-8")));
			} catch { /* skip malformed */ }
		}
	}

	return merged;
}
