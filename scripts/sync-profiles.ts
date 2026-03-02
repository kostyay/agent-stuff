/**
 * Sync Pi Profiles
 *
 * Syncs configuration files from a source pi profile to a destination profile.
 * Handles settings.json and keybindings.json via deep merge (source wins on conflict),
 * and copies extensions/*.json files wholesale.
 *
 * Usage:
 *   node --experimental-strip-types scripts/sync-profiles.ts <src> <dst> [--apply]
 *
 * Arguments:
 *   src     Source profile name (e.g. "agent-personal") or full path
 *   dst     Destination profile name (e.g. "agent-work") or full path
 *   --apply Actually write changes (default is dry-run)
 *
 * Examples:
 *   node --experimental-strip-types scripts/sync-profiles.ts agent-personal agent-work
 *   node --experimental-strip-types scripts/sync-profiles.ts agent-personal agent-work --apply
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// --- Types ---

interface DiffEntry {
  key: string;
  type: "added" | "changed" | "unchanged" | "removed";
  srcValue?: unknown;
  dstValue?: unknown;
}

interface SyncResult {
  file: string;
  diffs: DiffEntry[];
  written: boolean;
}

// --- Core Functions ---

/** Resolves a profile name or path to an absolute directory path. */
function resolveProfilePath(nameOrPath: string): string {
  const asAbsolute = resolve(nameOrPath);
  if (existsSync(asAbsolute)) {
    return asAbsolute;
  }
  const piDir = join(homedir(), ".pi", nameOrPath);
  if (existsSync(piDir)) {
    return piDir;
  }
  throw new Error(`Profile not found: "${nameOrPath}" (tried ${asAbsolute} and ${piDir})`);
}

/** Deep merges src into dst. Source values win on conflict. Arrays are replaced, not concatenated. */
function deepMerge(src: Record<string, unknown>, dst: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...dst };
  for (const key of Object.keys(src)) {
    const srcVal = src[key];
    const dstVal = result[key];
    if (isPlainObject(srcVal) && isPlainObject(dstVal)) {
      result[key] = deepMerge(srcVal as Record<string, unknown>, dstVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/** Returns true if value is a non-null, non-array plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Computes a flat diff between the before and after states of a JSON object. */
function diffObjects(before: Record<string, unknown>, after: Record<string, unknown>): DiffEntry[] {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const entries: DiffEntry[] = [];

  for (const key of [...allKeys].sort()) {
    const inBefore = key in before;
    const inAfter = key in after;

    if (!inBefore && inAfter) {
      entries.push({ key, type: "added", srcValue: after[key] });
    } else if (inBefore && !inAfter) {
      entries.push({ key, type: "removed", dstValue: before[key] });
    } else if (JSON.stringify(before[key]) === JSON.stringify(after[key])) {
      entries.push({ key, type: "unchanged", srcValue: after[key] });
    } else {
      entries.push({ key, type: "changed", srcValue: after[key], dstValue: before[key] });
    }
  }

  return entries;
}

/** Reads a JSON file, returning an empty object if it doesn't exist. */
function readJsonFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }
  const content = readFileSync(filePath, "utf-8");
  return JSON.parse(content) as Record<string, unknown>;
}

/** Syncs a single JSON file from src to dst using deep merge. */
function syncJsonFile(srcPath: string, dstPath: string, fileName: string, apply: boolean): SyncResult {
  const srcData = readJsonFile(srcPath);
  const dstData = readJsonFile(dstPath);

  if (Object.keys(srcData).length === 0) {
    return { file: fileName, diffs: [], written: false };
  }

  const merged = deepMerge(srcData, dstData);
  const diffs = diffObjects(dstData, merged);
  let written = false;

  if (apply && diffs.some((d) => d.type !== "unchanged")) {
    writeFileSync(dstPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
    written = true;
  }

  return { file: fileName, diffs, written };
}

/** Syncs the extensions/ directory: copies each JSON file from src to dst. */
function syncExtensionsDir(srcDir: string, dstDir: string, apply: boolean): SyncResult[] {
  if (!existsSync(srcDir)) {
    return [];
  }

  const files = readdirSync(srcDir).filter((f) => f.endsWith(".json"));
  const results: SyncResult[] = [];

  for (const file of files) {
    const srcPath = join(srcDir, file);
    const dstPath = join(dstDir, file);
    const srcData = readJsonFile(srcPath);
    const dstData = readJsonFile(dstPath);
    const isNew = !existsSync(dstPath);
    const diffs = diffObjects(dstData, srcData);
    let written = false;

    if (apply && (isNew || diffs.some((d) => d.type !== "unchanged"))) {
      mkdirSync(dstDir, { recursive: true });
      writeFileSync(dstPath, JSON.stringify(srcData, null, 2) + "\n", "utf-8");
      written = true;
    }

    results.push({
      file: `extensions/${file}${isNew ? " [new]" : ""}`,
      diffs,
      written,
    });
  }

  return results;
}

// --- Display ---

/** Formats a value for display, truncating long arrays/objects. */
function formatValue(value: unknown): string {
  const str = JSON.stringify(value);
  if (str.length > 80) {
    return str.slice(0, 77) + "...";
  }
  return str;
}

/** Prints the diff results for a single synced file. */
function printResult(result: SyncResult): void {
  const hasChanges = result.diffs.some((d) => d.type !== "unchanged");
  if (!hasChanges && result.diffs.length > 0) {
    console.log(`\n${result.file}: (no changes)`);
    return;
  }
  if (result.diffs.length === 0) {
    console.log(`\n${result.file}: (source file missing, skipped)`);
    return;
  }

  console.log(`\n${result.file}:${result.written ? " ✓ written" : ""}`);
  for (const diff of result.diffs) {
    switch (diff.type) {
      case "added":
        console.log(`  + ${diff.key}: ${formatValue(diff.srcValue)}`);
        break;
      case "changed":
        console.log(`  ~ ${diff.key}: ${formatValue(diff.dstValue)} → ${formatValue(diff.srcValue)}`);
        break;
      case "removed":
        console.log(`  - ${diff.key}: ${formatValue(diff.dstValue)}`);
        break;
      case "unchanged":
        console.log(`  = ${diff.key}: ${formatValue(diff.srcValue)}`);
        break;
    }
  }
}

// --- Main ---

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positional = args.filter((a) => a !== "--apply");

  if (positional.length !== 2) {
    console.error("Usage: sync-profiles.ts <src> <dst> [--apply]");
    console.error("Example: sync-profiles.ts agent-personal agent-work --apply");
    process.exit(1);
  }

  const srcDir = resolveProfilePath(positional[0]);
  const dstDir = resolveProfilePath(positional[1]);

  console.log(`Source:      ${srcDir}`);
  console.log(`Destination: ${dstDir}`);
  console.log(`Mode:        ${apply ? "APPLY" : "DRY RUN"}`);

  const results: SyncResult[] = [
    syncJsonFile(join(srcDir, "settings.json"), join(dstDir, "settings.json"), "settings.json", apply),
    syncJsonFile(join(srcDir, "keybindings.json"), join(dstDir, "keybindings.json"), "keybindings.json", apply),
    ...syncExtensionsDir(join(srcDir, "extensions"), join(dstDir, "extensions"), apply),
  ];

  for (const result of results) {
    printResult(result);
  }

  const changeCount = results.reduce((sum, r) => sum + r.diffs.filter((d) => d.type !== "unchanged").length, 0);

  console.log(`\n--- ${changeCount} change(s) across ${results.length} file(s) ---`);
  if (!apply && changeCount > 0) {
    console.log("Run with --apply to write changes.");
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
