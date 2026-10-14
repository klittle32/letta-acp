import type { LettaCodeModelEntry, UpdateModelOptions } from "@letta-ai/letta-agent-sdk";
import type { ModelSnapshot } from "./reasoning-options.js";
import { effectiveEffort, modelEntries, presetEffort } from "./reasoning-options.js";

export function modelHandle(entries: LettaCodeModelEntry[], model?: string): string | undefined {
  return entries.find((entry) => entry.id === model)?.handle ?? model;
}

/** Group only exact handles: provider aliases must not collapse BYOK routes. */
export function modelOptions(entries: LettaCodeModelEntry[]) {
  const groups = new Map<string, LettaCodeModelEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.handle) ?? [];
    group.push(entry);
    groups.set(entry.handle, group);
  }
  return [...groups].map(([handle, group]) => {
    // Catalogs commonly repeat the model label on every effort preset.
    // Do not guess by stripping suffixes from inconsistent preset labels.
    const plain = group.find((entry) =>
      entry.updateArgs?.reasoning_effort === undefined &&
      entry.updateArgs?.context_window === undefined);
    const commonLabel = group.every((entry) => entry.label === group[0]!.label)
      ? group[0]!.label : undefined;
    const commonDescription = group.every((entry) => entry.description === group[0]!.description)
      ? group[0]!.description : undefined;
    const description = plain?.description || commonDescription;
    return {
      value: handle,
      name: plain?.label || commonLabel || handle,
      ...(description ? { description } : {}),
    };
  });
}

/** Preserve effort, then prefer medium, then use the runtime's first catalog
 * preset. A different model uses its own window, never the old model's window.
 */
export function modelSelection(
  entries: LettaCodeModelEntry[],
  value: string,
  current: ModelSnapshot,
  aliases?: Record<string, string>,
): string | UpdateModelOptions | undefined {
  if (value === modelHandle(entries, current.model)) return undefined;
  const group = entries.filter((entry) => entry.handle === value);
  // Preserve explicit preset IDs and custom handles (also used by /model).
  if (!group.length) return value;
  const candidates = modelEntries(entries, value, aliases);
  const effort = effectiveEffort(current.settings, current.legacy);
  const selected = (effort === undefined ? undefined : candidates.find((entry) =>
    presetEffort(entry) === effort)) ??
    candidates.find((entry) => presetEffort(entry) === "medium") ??
    candidates[0]!;
  return { modelId: selected.id, modelHandle: value };
}
