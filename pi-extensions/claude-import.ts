/**
 * Claude Import — Load commands, skills, and agents from Claude Code's .claude/ directories
 *
 * Scans both project-level (.claude/) and global (~/.claude/) for:
 *   commands/*.md  → registered as /claude:<name>
 *   skills/        → registered as /claude:skill:<name>
 *   agents/*.md    → discovery only, listed via /claude:agents
 *
 * All names are prefixed with "claude:" to avoid collisions with pi-native commands/skills.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// ── Types ────────────────────────────────────────

interface Discovered {
	name: string;
	description: string;
	content: string;
}

interface SourceGroup {
	label: string;
	commands: Discovered[];
	skills: Discovered[];
	agents: Discovered[];
}

// ── Frontmatter Parsing ──────────────────────────

interface ParsedFrontmatter {
	description: string;
	body: string;
	fields: Record<string, string>;
}

/** Parse simple YAML frontmatter delimited by `---`. */
function parseFrontmatter(raw: string): ParsedFrontmatter {
	const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match) return { description: "", body: raw, fields: {} };

	const fields: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return { description: fields.description || "", body: match[2], fields };
}

/** Extract a one-line description from raw content (first non-empty line). */
function firstNonEmptyLine(text: string): string {
	return text.split("\n").find((l) => l.trim())?.trim() || "";
}

// ── Argument Expansion ───────────────────────────

/** Expand `$ARGUMENTS`, `$@`, `$1`, `$2`, … placeholders in a command template. */
function expandArgs(template: string, args: string): string {
	const parts = args.split(/\s+/).filter(Boolean);
	let result = template.replace(/\$ARGUMENTS|\$@/g, args);
	for (let i = 0; i < parts.length; i++) {
		result = result.replaceAll(`$${i + 1}`, parts[i]);
	}
	return result;
}

// ── Directory Scanners ───────────────────────────

/** Scan a commands/ directory for .md files. */
function scanCommands(dir: string): Discovered[] {
	if (!existsSync(dir)) return [];
	const items: Discovered[] = [];
	try {
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".md")) continue;
			const raw = readFileSync(join(dir, file), "utf-8");
			const { description, body } = parseFrontmatter(raw);
			items.push({
				name: basename(file, ".md"),
				description: description || firstNonEmptyLine(body),
				content: body,
			});
		}
	} catch { /* unreadable dir */ }
	return items;
}

/**
 * Scan a skills/ directory for SKILL.md (subdirectory) or flat .md files.
 * Matches the Claude Code / Agent Skills convention.
 */
function scanSkills(dir: string): Discovered[] {
	if (!existsSync(dir)) return [];
	const items: Discovered[] = [];
	try {
		for (const entry of readdirSync(dir)) {
			const skillFile = join(dir, entry, "SKILL.md");
			const flatFile = join(dir, entry);

			if (existsSync(skillFile) && statSync(skillFile).isFile()) {
				const raw = readFileSync(skillFile, "utf-8");
				const { description, body } = parseFrontmatter(raw);
				items.push({
					name: entry,
					description: description || firstNonEmptyLine(body),
					content: raw,
				});
			} else if (entry.endsWith(".md") && statSync(flatFile).isFile()) {
				const raw = readFileSync(flatFile, "utf-8");
				const { description, body } = parseFrontmatter(raw);
				items.push({
					name: basename(entry, ".md"),
					description: description || firstNonEmptyLine(body),
					content: raw,
				});
			}
		}
	} catch { /* unreadable dir */ }
	return items;
}

/** Scan an agents/ directory for .md files with optional frontmatter name/description. */
function scanAgents(dir: string): Discovered[] {
	if (!existsSync(dir)) return [];
	const items: Discovered[] = [];
	try {
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".md")) continue;
			const raw = readFileSync(join(dir, file), "utf-8");
			const { fields } = parseFrontmatter(raw);
			items.push({
				name: fields.name || basename(file, ".md"),
				description: fields.description || "",
				content: raw,
			});
		}
	} catch { /* unreadable dir */ }
	return items;
}

// ── Extension ────────────────────────────────────

export default function claudeImportExtension(pi: ExtensionAPI): void {
	const home = homedir();
	const cwd = process.cwd();
	const groups: SourceGroup[] = [];

	// Scan project-level and global .claude/ directories
	for (const [dir, label] of [
		[join(cwd, ".claude"), ".claude"],
		[join(home, ".claude"), "~/.claude"],
	] as const) {
		const commands = scanCommands(join(dir, "commands"));
		const skills = scanSkills(join(dir, "skills"));
		const agents = scanAgents(join(dir, "agents"));

		if (commands.length || skills.length || agents.length) {
			groups.push({ label, commands, skills, agents });
		}
	}

	if (groups.length === 0) return;

	// ── Register commands and skills as /claude:* ────────────────────────

	const registered = new Set<string>();

	for (const g of groups) {
		for (const cmd of g.commands) {
			const cmdName = `claude:${cmd.name}`;
			if (registered.has(cmdName)) continue;
			registered.add(cmdName);

			pi.registerCommand(cmdName, {
				description: `[${g.label}] ${cmd.description}`.slice(0, 120),
				handler: async (args) => {
					pi.sendUserMessage(expandArgs(cmd.content, args || ""));
				},
			});
		}

		for (const skill of g.skills) {
			const cmdName = `claude:skill:${skill.name}`;
			if (registered.has(cmdName)) continue;
			registered.add(cmdName);

			pi.registerCommand(cmdName, {
				description: `[${g.label}] ${skill.description}`.slice(0, 120),
				handler: async (args) => {
					const task = args?.trim();
					pi.sendUserMessage(task ? `${skill.content}\n\nTask: ${task}` : skill.content);
				},
			});
		}
	}

	// ── /claude:agents — list discovered agents ──────────────────────────

	const allAgents = groups.flatMap((g) => g.agents.map((a) => ({ ...a, source: g.label })));

	if (allAgents.length > 0) {
		pi.registerCommand("claude:agents", {
			description: "List Claude Code agents discovered from .claude/agents/",
			handler: async (_args, ctx) => {
				const lines = allAgents.map(
					(a) => `${a.name} (${a.source})${a.description ? `: ${a.description}` : ""}`,
				);
				ctx.ui.notify(`Claude agents:\n${lines.join("\n")}`, "info");
			},
		});
	}

	// ── Boot notification ────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		const counts: string[] = [];
		let totalCommands = 0;
		let totalSkills = 0;
		let totalAgents = 0;

		for (const g of groups) {
			totalCommands += g.commands.length;
			totalSkills += g.skills.length;
			totalAgents += g.agents.length;
		}

		if (totalCommands) counts.push(`${totalCommands} command${totalCommands > 1 ? "s" : ""}`);
		if (totalSkills) counts.push(`${totalSkills} skill${totalSkills > 1 ? "s" : ""}`);
		if (totalAgents) counts.push(`${totalAgents} agent${totalAgents > 1 ? "s" : ""}`);

		if (counts.length === 0) return;

		const sources = groups.map((g) => g.label).join(", ");
		ctx.ui.notify(`Claude import: ${counts.join(", ")} from ${sources}`, "info");
	});
}
