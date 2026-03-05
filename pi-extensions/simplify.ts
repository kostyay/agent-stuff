/**
 * Simplify Extension
 *
 * Registers a `/simplify` command that detects the dominant language
 * of changed files and sends the matching `<lang>-code-simplifier`
 * skill as a user message for the agent to execute.
 *
 * Accepts explicit file paths as arguments. When no files are specified,
 * falls back to detecting uncommitted changes via git.
 *
 * Hooks into `agent_end` to propose running `/simplify` when source files
 * were modified during the agent's turn. Shows a timed confirmation that
 * auto-accepts after 5 seconds.
 *
 * To add a new language:
 *   1. Create `skills/<lang>-code-simplifier/SKILL.md`
 *   2. Add one entry to FILE_EXTENSIONS below
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { timedConfirm } from "../lib/timed-confirm.ts";

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

/** Extract the lowercase file extension (e.g. ".ts") from a path. */
function fileExtension(filePath: string): string {
	return filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
}

/** Check if a file path has a supported source extension. */
function isSupportedFile(file: string): boolean {
	return fileExtension(file) in FILE_EXTENSIONS;
}

/** Detect the dominant language from a list of file paths. */
function detectLanguage(files: string[]): string | null {
	const counts: Record<string, number> = {};

	for (const file of files) {
		const lang = FILE_EXTENSIONS[fileExtension(file)];
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
	return files.filter((f) => FILE_EXTENSIONS[fileExtension(f)] === lang);
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/** Split stdout into non-empty lines. */
function splitLines(stdout: string): string[] {
	return stdout.trim().split("\n").filter(Boolean);
}

/** List untracked files not covered by .gitignore. */
async function getUntrackedFiles(pi: ExtensionAPI): Promise<string[]> {
	const { stdout } = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"]);
	return splitLines(stdout);
}

/** Collect all changed files (unstaged + untracked, falling back to staged). */
async function getChangedFiles(pi: ExtensionAPI): Promise<string[]> {
	const { stdout: diffOut } = await pi.exec("git", ["diff", "--name-only", "HEAD"]);
	const files = [...splitLines(diffOut), ...await getUntrackedFiles(pi)];

	if (files.length > 0) return files;

	const { stdout: stagedOut } = await pi.exec("git", ["diff", "--name-only", "--staged"]);
	return splitLines(stagedOut);
}

/** Get all files changed since a specific commit (committed + staged + unstaged + untracked). */
async function getChangedFilesSince(pi: ExtensionAPI, commitHash: string): Promise<string[]> {
	const { stdout: diffOut } = await pi.exec("git", ["diff", "--name-only", commitHash]);
	return [...splitLines(diffOut), ...await getUntrackedFiles(pi)];
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Parsed `/simplify` command arguments. */
interface ParsedArgs {
	files: string[];
	extraInstructions: string | undefined;
}

/**
 * Parse command arguments into explicit file paths and extra instructions.
 *
 * Tokens with supported file extensions are treated as explicit file paths.
 * Remaining tokens are joined as extra instructions.
 */
function parseArgs(args: string): ParsedArgs {
	const trimmed = args.trim();
	if (!trimmed) return { files: [], extraInstructions: undefined };

	const tokens = trimmed.split(/\s+/);
	const files: string[] = [];
	const instructionTokens: string[] = [];

	for (const token of tokens) {
		if (isSupportedFile(token)) {
			files.push(token);
		} else {
			instructionTokens.push(token);
		}
	}

	return {
		files,
		extraInstructions: instructionTokens.length > 0 ? instructionTokens.join(" ") : undefined,
	};
}

// ---------------------------------------------------------------------------
// Core simplify logic
// ---------------------------------------------------------------------------

/** Notification callback type. */
type Notify = (message: string, level: "info" | "warning" | "error") => void;

/**
 * Resolve files, detect language, build prompt, and send it.
 *
 * When `files` is provided, uses those directly. Otherwise falls back
 * to detecting changed files via git.
 *
 * Returns `true` if the prompt was sent.
 */
async function triggerSimplify(
	pi: ExtensionAPI,
	options: { files?: string[]; extraInstructions?: string },
	notify: Notify,
): Promise<boolean> {
	const files = options.files?.length
		? options.files
		: await getChangedFiles(pi);

	if (files.length === 0) {
		notify("No changed files found", "info");
		return false;
	}

	const lang = detectLanguage(files);
	if (!lang) {
		const available = listAvailableSkills();
		notify(
			`No supported language detected. Available: ${available.join(", ") || "none"}`,
			"warning",
		);
		return false;
	}

	const skillContent = readSkillContent(lang);
	if (!skillContent) {
		notify(`Skill not found: skills/${skillDir(lang)}/SKILL.md`, "error");
		return false;
	}

	const relevantFiles = filterByLanguage(files, lang);
	notify(`Simplifying ${relevantFiles.length} ${lang.toUpperCase()} file(s)…`, "info");

	simplifyPending = true;
	pi.sendUserMessage(buildPrompt(skillContent, relevantFiles, options.extraInstructions));
	return true;
}

/**
 * Build a human-readable message for the auto-simplify confirmation.
 *
 * Lists file names when ≤2 files, otherwise just shows the count.
 */
function buildConfirmMessage(files: string[], lang: string): string {
	const label = lang.toUpperCase();
	const count = files.length;
	const noun = count === 1 ? "file" : "files";

	if (count <= 2) {
		const names = files.join(", ");
		return `${count} ${label} ${noun} changed: ${names}. Run /simplify?`;
	}

	return `${count} ${label} ${noun} changed. Run /simplify?`;
}

// ---------------------------------------------------------------------------
// Agent turn tracking state
// ---------------------------------------------------------------------------

/** HEAD commit hash recorded at the start of the agent's turn. */
let headSnapshot: string | null = null;

/** Whether `/simplify` was invoked during the current agent turn. */
let simplifyRanThisTurn = false;

/**
 * Set by `triggerSimplify` before `sendUserMessage` so the next
 * `before_agent_start` can propagate it into `simplifyRanThisTurn`.
 * This survives the turn boundary that would otherwise reset the flag.
 */
let simplifyPending = false;

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/** Registers the `/simplify` command and agent_end auto-simplify hook. */
export default function simplifyExtension(pi: ExtensionAPI) {
	// ── Snapshot HEAD at turn start ─────────────────────────────────

	pi.on("before_agent_start", async () => {
		headSnapshot = null;
		simplifyRanThisTurn = simplifyPending;
		simplifyPending = false;

		const { stdout, code } = await pi.exec("git", ["rev-parse", "HEAD"]);
		if (code === 0 && stdout.trim()) {
			headSnapshot = stdout.trim();
		}
	});

	// ── /simplify command ───────────────────────────────────────────

	pi.registerCommand("simplify", {
		description:
			"Detect the language of changed files and apply the matching code-simplifier skill. " +
			"Pass explicit file paths to target specific files. " +
			"Extra text that doesn't match a file extension is forwarded as additional instructions.",
		handler: async (args, ctx) => {
			const { files, extraInstructions } = parseArgs(args);
			await triggerSimplify(
				pi,
				{ files: files.length > 0 ? files : undefined, extraInstructions },
				(msg, level) => ctx.ui.notify(msg, level),
			);
		},
	});

	// ── Auto-simplify proposal after agent turn ─────────────────────

	pi.on("agent_end", async (_event: unknown, ctx: ExtensionContext) => {
		if (!ctx.hasUI || simplifyRanThisTurn || !headSnapshot) return;

		const allChanged = await getChangedFilesSince(pi, headSnapshot);
		const sourceFiles = allChanged.filter(isSupportedFile);
		if (sourceFiles.length === 0) return;

		const lang = detectLanguage(sourceFiles);
		if (!lang) return;

		const relevantFiles = filterByLanguage(sourceFiles, lang);
		if (relevantFiles.length === 0) return;

		const confirmed = await timedConfirm(ctx, {
			title: "Simplify code",
			message: buildConfirmMessage(relevantFiles, lang),
			seconds: 5,
			defaultValue: true,
		});

		if (!confirmed) return;

		await triggerSimplify(
			pi,
			{ files: sourceFiles },
			(msg, level) => ctx.ui.notify(msg, level),
		);
	});
}
