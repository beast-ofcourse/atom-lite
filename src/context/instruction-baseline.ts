import { createHash } from "node:crypto";

export const INSTRUCTION_BASELINE_VERSION = 1;

export interface InstructionUpdate {
  seq: number;
  hash: string;
  values: string[];
}

/** Frozen instruction text plus chronological updates for one session epoch. */
export interface InstructionBaselineState {
  schemaVersion: number;
  baselineSeq: number;
  baseline: string[];
  updates: InstructionUpdate[];
}

export function hashInstructions(values: string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

export function initialBaseline(
  values: string[],
  seq = 0,
): InstructionBaselineState {
  return {
    schemaVersion: INSTRUCTION_BASELINE_VERSION,
    baselineSeq: seq,
    baseline: [...values],
    updates: [],
  };
}

function lastHash(state: InstructionBaselineState): string {
  const last = state.updates.at(-1);
  return last ? last.hash : hashInstructions(state.baseline);
}

/** Append an update only when current text differs from the latest snapshot. */
export function recordInstructionChange(
  state: InstructionBaselineState,
  values: string[],
  seq: number,
): InstructionBaselineState {
  const hash = hashInstructions(values);
  if (hash === lastHash(state)) return state;
  return {
    ...state,
    updates: [...state.updates, { seq, hash, values: [...values] }],
  };
}

/** Start a new epoch at compaction: current text becomes the frozen baseline. */
export function foldInstructionBaseline(
  state: InstructionBaselineState,
  values: string[],
  seq: number,
): InstructionBaselineState {
  return {
    schemaVersion: INSTRUCTION_BASELINE_VERSION,
    baselineSeq: seq,
    baseline: [...values],
    updates: [],
  };
}

/** Drop updates at or after a sequence, keeping the frozen baseline. */
export function rewindInstructionBaseline(
  state: InstructionBaselineState,
  seq: number,
): InstructionBaselineState {
  return {
    ...state,
    updates: state.updates.filter((update) => update.seq < seq),
  };
}

/** Render the baseline followed by new text introduced by each update. */
export function renderedInstructionTexts(
  state: InstructionBaselineState,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of [...state.baseline, ...state.updates.flatMap((u) => u.values)]) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
