import type { LettaCodeModelEntry, UpdateModelOptions } from "@letta-ai/letta-agent-sdk";
import type { ModelSnapshot } from "./reasoning-options.js";
import { effectiveEffort, modelEntries, presetEffort } from "./reasoning-options.js";

export function modelHandle(entries: LettaCodeModelEntry[], model?: string): string | undefined {
  return entries.find((entry) => entry.id === model)?.handle ?? model;
}

/** A display name must be nonblank and differ from the option value: some
 * clients (JetBrains Air) reject a model list containing a handle as its own
 * name. Values always remain the exact route handle. */
function displayName(label: string | undefined, handle: string): string | undefined {
  const trimmed = label?.trim();
  return trimmed && trimmed !== handle ? trimmed : undefined;
}

/** Shown for a route with no usable catalog label. */
function handleLabel(handle: string): string {
  return `Model: ${handle}`;
}

/** Shown for an active route that the catalog does not list. */
export function currentHandleLabel(handle: string): string {
  return `${handle} (current)`;
}

/**
 * One label per route, chosen from existing catalog labels: a plain entry's
 * label, else the shortest label of the first context family that every label
 * of that family starts with at a word boundary ("Gemini 4 Argon" for
 * "Gemini 4 Argon (low)" / "Gemini 4 Argon" / "Gemini 4 Argon (high)";
 * identical labels are the trivial case). Labels are never cut down to an
 * invented name; without a usable label the handle is shown decorated.
 */
function modelLabel(handle: string, group: LettaCodeModelEntry[]): string {
  const plain = group.find((entry) =>
    entry.updateArgs?.reasoning_effort === undefined &&
    entry.updateArgs?.context_window === undefined);
  // Context-size families are often labelled apart ("Luna" / "Luna 1M").
  const family = group.filter((entry) =>
    entry.updateArgs?.context_window === group[0]?.updateArgs?.context_window);
  const labels = family.map((entry) => entry.label?.trim() ?? "");
  const shared = labels.every(Boolean) ? [...labels].sort((a, b) => a.length - b.length)
    .find((candidate) => labels.every((label) =>
      label === candidate || label.startsWith(`${candidate} `))) : undefined;
  return displayName(plain?.label, handle) ?? displayName(shared, handle) ?? handleLabel(handle);
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
    const plain = group.find((entry) =>
      entry.updateArgs?.reasoning_effort === undefined &&
      entry.updateArgs?.context_window === undefined);
    const family = group.filter((entry) =>
      entry.updateArgs?.context_window === group[0]!.updateArgs?.context_window);
    const commonDescription = family.every((entry) => entry.description === family[0]!.description)
      ? family[0]!.description : undefined;
    const description = plain?.description || commonDescription;
    return {
      value: handle,
      name: modelLabel(handle, group),
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
