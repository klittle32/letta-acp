import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { LettaCodeModelEntry } from "@letta-ai/letta-agent-sdk";
import {
  EFFORTS,
  modelEntries,
  presetEffort,
  presetWindow,
  type ReasoningEffort,
} from "./reasoning-options.js";

export const CONTEXT_WINDOW_ID = "context_window";
export const PRESET_ID = "letta_preset";
/** Display-only values: state shown truthfully, never a selectable choice. */
export const UNKNOWN_VALUE = "unknown";
export const CURRENT_VALUE = "current";

/**
 * Shape of Letta's effort presets for one route. Clients such as T3 render
 * each option as a fixed list and replay stored selections against a single
 * snapshot, so separate Effort and Context lists are offered only when every
 * pair the lists can express is a real preset:
 *
 * - rectangular: every effort exists at every window, and the presets applied
 *   for one effort differ only in `context_window` (a single window is the
 *   trivial case);
 * - sparse: some pairs are missing, so one selector lists the real presets;
 * - windowless: no preset carries a window, so only effort is offered.
 */
export type PresetGrid =
  | { kind: "none" }
  | { kind: "windowless"; presets: LettaCodeModelEntry[] }
  | { kind: "rectangular"; presets: LettaCodeModelEntry[]; efforts: ReasoningEffort[]; windows: number[] }
  | { kind: "sparse"; presets: LettaCodeModelEntry[]; tuples: LettaCodeModelEntry[] };

function withoutWindow(entry: LettaCodeModelEntry): string {
  return JSON.stringify(Object.entries(entry.updateArgs ?? {})
    .filter(([key]) => key !== "context_window")
    .sort(([a], [b]) => a.localeCompare(b)));
}

/** First preset in catalog order: the runtime resolves ties the same way. */
export function presetFor(
  presets: LettaCodeModelEntry[],
  effort: ReasoningEffort | undefined,
  window: number | undefined,
): LettaCodeModelEntry | undefined {
  return presets.find((entry) => presetEffort(entry) === effort && presetWindow(entry) === window);
}

export function presetGrid(
  entries: LettaCodeModelEntry[],
  model: string | undefined,
  aliases?: Record<string, string>,
): PresetGrid {
  const presets = modelEntries(entries, model, aliases)
    .filter((entry) => presetEffort(entry) !== undefined);
  if (!presets.length) return { kind: "none" };
  const windowed = presets.filter((entry) => presetWindow(entry) !== undefined);
  if (!windowed.length) return { kind: "windowless", presets };
  const efforts = EFFORTS.filter((effort) => presets.some((entry) => presetEffort(entry) === effort));
  const windows = [...new Set(windowed.map((entry) => presetWindow(entry)!))].sort((a, b) => a - b);
  // Compare only the preset each (tier, window) pair actually applies: later
  // duplicates (a BYOK native clone of a base preset, or an Anthropic xhigh
  // and max that Letta both persists as max) are never selected.
  const rectangular = windowed.length === presets.length && efforts.every((effort) => {
    const applied = windows.map((window) => presetFor(presets, effort, window));
    return applied.every((entry) => entry !== undefined) &&
      new Set(applied.map((entry) => withoutWindow(entry!))).size === 1;
  });
  if (rectangular) return { kind: "rectangular", presets, efforts, windows };
  const tuples = presets.filter((entry, index) =>
    presets.findIndex((other) => presetEffort(other) === presetEffort(entry) &&
      presetWindow(other) === presetWindow(entry)) === index)
    .sort((a, b) => (presetWindow(a) ?? 0) - (presetWindow(b) ?? 0) ||
      EFFORTS.indexOf(presetEffort(a)!) - EFFORTS.indexOf(presetEffort(b)!));
  return { kind: "sparse", presets, tuples };
}

/** Exact pair when Letta has it; from an off-grid window, the first catalog
 * preset for that effort (so the window moves to a listed preset window). */
export function effortTarget(
  grid: Extract<PresetGrid, { kind: "rectangular" }>,
  effort: ReasoningEffort,
  window: number | undefined,
): LettaCodeModelEntry {
  return presetFor(grid.presets, effort, window) ??
    grid.presets.find((entry) => presetEffort(entry) === effort)!;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 10_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return tokens.toLocaleString("en-US");
}

const tokens = (window: number) => `${formatTokens(window)} tokens`;

/** Shown when presets offer a window choice or the actual window is off-grid. */
export function contextOption(
  grid: Extract<PresetGrid, { kind: "rectangular" }>,
  current: number | undefined,
): SessionConfigOption | undefined {
  if (current === undefined) return undefined;
  const windows = [...new Set([...grid.windows, current])].sort((a, b) => a - b);
  if (windows.length < 2) return undefined;
  return {
    id: CONTEXT_WINDOW_ID,
    name: "Context size",
    description: "Context window from Letta's presets for this model; keeps the reasoning tier",
    category: "model_config",
    type: "select",
    currentValue: String(current),
    options: windows.map((window) => ({
      value: String(window),
      name: grid.windows.includes(window) ? tokens(window) : `${tokens(window)} (current, not a Letta preset)`,
    })),
  };
}

export function effortOption(
  grid: Extract<PresetGrid, { kind: "rectangular" }>,
  current: ReasoningEffort | undefined,
  window: number | undefined,
): SessionConfigOption {
  const options: Array<{ value: string; name: string }> = EFFORTS
    .filter((value) => grid.efforts.includes(value) || value === current)
    .map((value) => ({
      value,
      name: grid.efforts.includes(value) ? value : `${value} (current, not a Letta preset for this model)`,
    }));
  if (current === undefined) options.unshift({ value: UNKNOWN_VALUE, name: "Not reported" });
  const onGrid = window !== undefined && grid.windows.includes(window);
  return {
    id: "reasoning_effort",
    name: "Reasoning effort",
    description: onGrid
      ? "Reasoning tier from Letta's presets for this model; keeps the context size"
      : "Reasoning tier from Letta's presets; choosing one moves the context size to that preset's window",
    category: "thought_level",
    type: "select",
    currentValue: current ?? UNKNOWN_VALUE,
    options,
  };
}

function tupleName(effort: ReasoningEffort | undefined, window: number | undefined): string {
  return [effort ?? "effort not reported", window === undefined ? undefined : tokens(window)]
    .filter(Boolean).join(" · ");
}

/** One selector of real presets when separate lists could express pairs
 * Letta does not offer. */
export function presetOption(
  grid: Extract<PresetGrid, { kind: "sparse" }>,
  effort: ReasoningEffort | undefined,
  window: number | undefined,
): SessionConfigOption {
  const current = presetFor(grid.tuples, effort, window);
  const options = grid.tuples.map((entry) => ({
    value: entry.id, name: tupleName(presetEffort(entry), presetWindow(entry)),
  }));
  if (!current) options.unshift({ value: CURRENT_VALUE, name: `${tupleName(effort, window)} (current, not a Letta preset)` });
  return {
    id: PRESET_ID,
    name: "Reasoning & context",
    description: "Letta presets for this model; it does not offer every reasoning tier at every context size",
    category: "thought_level",
    type: "select",
    currentValue: current?.id ?? CURRENT_VALUE,
    options,
  };
}
