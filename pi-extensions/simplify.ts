/**
 * Simplify Extension
 *
 * Registers a `/simplify` command that detects the dominant language
 * of uncommitted changes and sends the matching `<lang>-code-simplifier`
 * skill as a user message for the agent to execute.
 *
 * To add a new language:
 *   1. Create `skills/<lang>-code-simplifier/SKILL.md`
 *   2. Add one entry to FILE_EXTENSIONS below
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Configuration — add new languages here
// ---------------------------------------------------------------------------

/**
 * Map from file extension to language key.
 *
 * The language key must match a `skills/<key>-code-simplifier/` directory.
 * Add a single line to support a new language.
 */
const FILE_EXTENSIONS: Record<string, string> = {
	".ts": "js",
	".tsx": "js",
	".js": "js",
	".jsx": "js",
	".mjs": "js",
	".cjs": "js",
	".mts": "js",
	".cts": "js",
	".go": "go",
	".py": "py",
	".pyi": "py",
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Package root (parent of `pi-extensions/`). */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Skill directory name for a language key. */
function skillDir(lang: string): string {
	return `${lang}-code-simplifier`;
}

/** Detect the dominant language from a list of changed file paths. */
function detectLanguage(files: string[]): string | null {
	const counts: Record<string, number> = {};

	for (const file of files) {
		const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
		const lang = FILE_EXTENSIONS[ext];
		if (lang) {
			counts[lang] = (counts[lang] ?? 0) + 1;
		}
	}

	let best: string | null = null;
	let bestCount = 0;
	for (const [lang, count] of Object.entries(counts)) {
		if (count > bestCount) {
			best = lang;
			bestCount = count;
		}
	}
	return best;
}

/** Read the SKILL.md content for a language key. Returns null if missing. */
function readSkillContent(lang: string): string | null {
	try {
		return readFileSync(
			resolve(PACKAGE_ROOT, "skills", skillDir(lang), "SKILL.md"),
			"utf-8",
		);
	} catch {
		return null;
	}
}

/** List available simplifier skill keys by scanning the skills directory. */
function listAvailableSkills(): string[] {
	try {
		return readdirSync(resolve(PACKAGE_ROOT, "skills"))
			.filter((name) => name.endsWith("-code-simplifier"))
			.map((name) => name.replace("-code-simplifier", ""));
	} catch {
		return [];
	}
}

/** Build the user message combining skill instructions, changed files, and optional extra instructions. */
function buildPrompt(skillContent: string, files: string[], extraInstructions?: string): string {
	const fileList = files.map((f) => `- ${f}`).join("\n");
	const parts = [
		"Apply the following code simplification skill to the changed files listed below.",
		"Read each file, plan your changes, apply them, then summarize what you simplified.",
		"",
		"## Changed files",
		"",
		fileList,
		"",
		"## Skill instructions",
		"",
		skillContent,
	];

	if (extraInstructions) {
		parts.push("", "## Additional instructions", "", extraInstructions);
	}

	return parts.join("\n");
}

/** Filter files to those matching a language key. */
function filterByLanguage(files: string[], lang: string): string[] {
	return files.filter((f) => {
		const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
		return FILE_EXTENSIONS[ext] === lang;
	});
}

/** Collect all changed files (unstaged + untracked, falling back to staged). */
async function getChangedFiles(pi: ExtensionAPI): Promise<string[]> {
	const { stdout: diffOut } = await pi.exec("git", ["diff", "--name-only", "HEAD"]);
	const { stdout: untrackedOut } = await pi.exec("git", [
		"ls-files", "--others", "--exclude-standard",
	]);

	const files = [
		...diffOut.trim().split("\n").filter(Boolean),
		...untrackedOut.trim().split("\n").filter(Boolean),
	];

	if (files.length > 0) return files;

	const { stdout: stagedOut } = await pi.exec("git", ["diff", "--name-only", "--staged"]);
	return stagedOut.trim().split("\n").filter(Boolean);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/** Registers the `/simplify` command. */
export default function simplifyExtension(pi: ExtensionAPI) {
	pi.registerCommand("simplify", {
		description:
			"Detect the language of uncommitted changes and apply the matching code-simplifier skill. Extra text after the command is forwarded as additional instructions.",
		handler: async (args, ctx) => {
			const changedFiles = await getChangedFiles(pi);
			if (changedFiles.length === 0) {
				ctx.ui.notify("No changed files found", "info");
				return;
			}

			const lang = detectLanguage(changedFiles);
			if (!lang) {
				const available = listAvailableSkills();
				ctx.ui.notify(
					`No supported language detected. Available: ${available.join(", ") || "none"}`,
					"warning",
				);
				return;
			}

			const skillContent = readSkillContent(lang);
			if (!skillContent) {
				ctx.ui.notify(
					`Skill not found: skills/${skillDir(lang)}/SKILL.md`,
					"error",
				);
				return;
			}

			const relevantFiles = filterByLanguage(changedFiles, lang);
			ctx.ui.notify(
				`Simplifying ${relevantFiles.length} ${lang.toUpperCase()} file(s)…`,
				"info",
			);

			const extraInstructions = args.trim() || undefined;
			pi.sendUserMessage(buildPrompt(skillContent, relevantFiles, extraInstructions));
		},
	});
}
