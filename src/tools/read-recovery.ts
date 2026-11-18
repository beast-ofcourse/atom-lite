import { existsSync } from "node:fs";
import { readdir, stat as statAsync } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { isWithinWorkspace } from "../security/paths.js";

const MAX_SUGGESTIONS = 3;

export interface RecoveredPath {
  path: string;
  displayPath: string;
}

export interface RecoveryFailure {
  message: string;
}

export type RecoveryResult = RecoveredPath | RecoveryFailure | null;

/** Fold Unicode look-alikes before comparing names. */
const canonical = (name: string): string =>
  name.normalize("NFC").replace(/[\u00a0\u202f]/g, " ").replace(/[\u2018\u2019]/g, "'");

const stem = (name: string): string => name.slice(0, name.length - extname(name).length) || name;

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length];
}

function ranked(names: string[], wanted: string): string[] {
  const target = canonical(wanted).toLowerCase();
  const targetStem = canonical(stem(wanted)).toLowerCase();
  const typos = targetStem.length < 3 ? 0 : targetStem.length < 5 ? 1 : 2;
  return names
    .flatMap((name) => {
      const lower = canonical(name).toLowerCase();
      if (lower === target) return [];
      const foundStem = canonical(stem(name)).toLowerCase();
      let tier: number | undefined;
      if (foundStem === targetStem) tier = 1;
      else if (
        Math.min(foundStem.length, targetStem.length) >= 3 &&
        (lower.includes(target) || target.includes(lower) || foundStem.includes(targetStem) || targetStem.includes(foundStem))
      )
        tier = 2;
      else if (typos > 0 && Math.abs(foundStem.length - targetStem.length) <= typos && editDistance(foundStem, targetStem) <= typos)
        tier = 3;
      return tier === undefined ? [] : [{ name, tier, distance: editDistance(lower, target) }];
    })
    .sort((a, b) => a.tier - b.tier || a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.name);
}

async function list(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

function withinWorkspace(workspace: string, candidate: string): boolean {
  const relativePath = relative(workspace, candidate);
  return relativePath !== "" && isWithinWorkspace(workspace, relativePath);
}

/** Correct an absolute path written from the workspace's parent directory. */
export function rerootReadPath(workspace: string, requested: string): RecoveredPath | null {
  if (!isAbsolute(requested)) return null;
  const parent = dirname(workspace);
  if (isWithinWorkspace(workspace, requested) || !isWithinWorkspace(parent, requested)) return null;
  const target = join(workspace, relative(parent, requested));
  if (!withinWorkspace(workspace, target) || !existsSync(target)) return null;
  return { path: target, displayPath: relative(workspace, target) };
}

async function usable(workspace: string, candidate: string): Promise<RecoveredPath | null> {
  if (!withinWorkspace(workspace, candidate)) return null;
  try {
    await statAsync(candidate);
  } catch {
    return null;
  }
  return { path: candidate, displayPath: relative(workspace, candidate) };
}

/**
 * Try one bounded correction for a missing path: canonical name, same-stem
 * sibling, wrong root, then a ranked suggestion list. Never reads outside the
 * workspace and performs at most two directory lookups.
 */
export async function recoverReadPath(
  workspace: string,
  requested: string,
  absolute: string,
): Promise<RecoveryResult> {
  const directory = dirname(absolute);
  const wanted = basename(absolute);
  const names = await list(directory);

  for (const name of names) {
    if (canonical(name) !== canonical(wanted)) continue;
    const recovered = await usable(workspace, join(directory, name));
    if (recovered) return recovered;
  }

  const wantedStem = canonical(stem(wanted));
  const sameStem = names.filter(
    (name) => canonical(stem(name)) === wantedStem && canonical(name) !== canonical(wanted),
  );
  if (sameStem.length === 1) {
    const recovered = await usable(workspace, join(directory, sameStem[0]));
    if (recovered) return recovered;
  }

  if (isAbsolute(requested)) {
    const parent = dirname(workspace);
    if (!isWithinWorkspace(workspace, requested) && isWithinWorkspace(parent, requested)) {
      const rerooted = join(workspace, relative(parent, requested));
      const recovered = await usable(workspace, rerooted);
      if (recovered) return recovered;
    }
  }

  let suggestions = names;
  let folderNote = "";
  if (!existsSync(directory)) {
    let nearest = directory;
    while (!existsSync(nearest)) {
      const parent = dirname(nearest);
      if (parent === nearest) break;
      nearest = parent;
    }
    const firstMissing = relative(nearest, directory).split(/[\\/]/)[0];
    suggestions = await list(nearest);
    folderNote = `The folder ${firstMissing} does not exist. The nearest folder that does is ${
      relative(workspace, nearest) || "."
    }.`;
  }

  let message = `FILE_NOT_FOUND: ${requested}`;
  if (folderNote) message += `\n${folderNote}`;
  const suggestionsText = ranked(suggestions, wanted);
  if (suggestionsText.length > 0)
    message += `\nDid you mean one of these?\n${suggestionsText.join("\n")}`;
  return { message };
}
