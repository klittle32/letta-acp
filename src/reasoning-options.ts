import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { LettaCodeModelEntry } from "@letta-ai/letta-agent-sdk";

export const EFFORTS = [
  "none", "minimal", "low", "medium", "high", "xhigh", "max",
] as const;
export type ReasoningEffort = typeof EFFORTS[number];

/** Match Letta Code 0.34.14 buildModelSettings, not a universal xhigh alias.
 * Older Anthropic models persist their xhigh preset as max; newer ones retain
 * distinct xhigh and max tiers. Exact preset IDs still perform the update.
 */
export function presetEffort(entry: LettaCodeModelEntry): ReasoningEffort | undefined {
  const args = entry.updateArgs;
  const effort = args?.reasoning_effort;
  const anthropic = ["anthropic", "bedrock"].includes(String(args?.provider_type)) ||
    /^(anthropic|lc-anthropic|claude-pro-max|minimax|bedrock)\//.test(entry.handle);
  if (anthropic && args?.enable_reasoner === false) return "none";
  if (anthropic && effort === "xhigh" &&
      !["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-7", "claude-opus-4-8"]
        .some((model) => entry.handle.includes(model))) return "max";
  return isReasoningEffort(effort) ? effort : undefined;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return EFFORTS.some((effort) => effort === value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Read explicit settings only: missing/null is not evidence of a default tier. */
export function effectiveEffort(
  settings: Record<string, unknown>,
  legacy: Record<string, unknown> = {},
): ReasoningEffort | undefined {
  if (record(settings.thinking).type === "disabled") return "none";
  const reasoning = record(settings.reasoning);
  const value = "reasoning" in settings
    ? reasoning.reasoning_effort
    : "effort" in settings ? settings.effort
    : "reasoning_effort" in settings ? settings.reasoning_effort
    : legacy.reasoning_effort;
  if (isReasoningEffort(value)) return value;
  if (value === undefined && !("reasoning" in settings) &&
      (settings.enable_reasoner ?? legacy.enable_reasoner) === false) return "none";
  return undefined;
}

export interface ModelSnapshot {
  model?: string;
  settings: Record<string, unknown>;
  legacy?: Record<string, unknown>;
  contextWindow?: number;
}

/** Match Letta Code's scoped model settings: a different model drops inheritance.
 * Conversation fields override independently: a settings-only override (no
 * conversation model) still applies to the agent's route.
 */
export function scopedModelSnapshot(agent: unknown, conversation?: unknown): ModelSnapshot {
  const base = record(agent);
  const legacy = record(base.llm_config);
  const saved = record(legacy.model_settings ?? base.model_settings);
  const model = typeof base.model === "string" ? base.model : undefined;
  const override = record(conversation);
  const baseWindow = base.context_window_limit ?? legacy.context_window;
  const window = override.context_window_limit ?? (
    !override.model || override.model === model ? baseWindow : undefined
  );
  const contextWindow = typeof window === "number" ? window : undefined;
  const scopedModel = typeof override.model === "string" && override.model ? override.model : undefined;
  const hasScopedSettings = Object.keys(record(override.model_settings)).length > 0;
  if (scopedModel || hasScopedSettings) {
    const sameModel = !scopedModel || scopedModel === model;
    const inherited = sameModel ? { ...legacy, ...saved } : {};
    const scoped = record(override.model_settings);
    // An explicit scoped selector (including null/provider default) replaces
    // all inherited representations, not just the spelling used by its provider.
    const hasEffort = ["reasoning", "effort", "reasoning_effort"].some((key) =>
      Object.hasOwn(scoped, key)) || record(scoped.thinking).type === "disabled";
    if (hasEffort) {
      delete inherited.reasoning;
      delete inherited.effort;
      delete inherited.reasoning_effort;
      delete inherited.enable_reasoner;
      delete inherited.thinking;
    }
    return {
      model: scopedModel ?? model,
      settings: { ...inherited, ...scoped },
      legacy: sameModel && !hasEffort ? legacy : {},
      contextWindow,
    };
  }
  return { model, settings: { ...legacy, ...saved }, legacy, contextWindow };
}

/** SDK capability resolution is the union of the alias base and exact route.
 * Keep catalog order: the runtime resolves handles/preset ties by first match.
 */
export function modelEntries(
  entries: LettaCodeModelEntry[],
  model: string | undefined,
  aliases?: Record<string, string>,
): LettaCodeModelEntry[] {
  if (!model) return [];
  const handle = entries.find((entry) => entry.id === model)?.handle ?? model;
  const slash = handle.indexOf("/");
  const provider = handle.slice(0, slash);
  const canonical = slash > 0 && aliases?.[provider]
    ? `${aliases[provider]}${handle.slice(slash)}`
    : handle;
  return entries.filter((entry) => entry.handle === handle || entry.handle === canonical);
}

export function presetWindow(entry: LettaCodeModelEntry): number | undefined {
  const window = entry.updateArgs?.context_window;
  return typeof window === "number" ? window : undefined;
}

/** Letta Code's runtime refuses to preserve this legacy server clamp unless a
 * preset for the route carries exactly this window. */
const LEGACY_CONTEXT_WINDOW_CLAMP = 128_000;

/**
 * Effort presets that keep the session's actual context window: the family
 * whose preset window equals it, or presets that carry no window at all (the
 * runtime preserves the current window for those, except the legacy clamp).
 * An off-preset or unknown window offers no windowed presets, because applying
 * any of them would change the context as a side effect.
 */
export function reasoningEntries(
  entries: LettaCodeModelEntry[],
  model: string | undefined,
  aliases?: Record<string, string>,
  contextWindow?: number,
): LettaCodeModelEntry[] {
  const candidates = modelEntries(entries, model, aliases);
  const matching = candidates.filter((entry) => presetWindow(entry) === contextWindow);
  const family = matching.length ? matching
    : contextWindow === LEGACY_CONTEXT_WINDOW_CLAMP ? []
    : candidates.filter((entry) => presetWindow(entry) === undefined);
  return family.filter((entry) => presetEffort(entry) !== undefined);
}

/**
 * Effort selector for routes whose presets carry no window (see preset-grid).
 * A known effort with no applicable preset is still shown as the current value
 * (ACP requires currentValue to be an option); it is state, not a choice.
 */
export function reasoningOption(
  entries: LettaCodeModelEntry[],
  effort: ReasoningEffort | undefined,
): SessionConfigOption | undefined {
  const supported = EFFORTS.filter((value) =>
    entries.some((entry) => presetEffort(entry) === value));
  if (!effort) return undefined;
  const current = supported.includes(effort);
  const options = EFFORTS.filter((value) => value === effort || supported.includes(value))
    .map((value) => ({
      value,
      name: supported.includes(value) ? value : `${value} (current, not a Letta preset here)`,
    }));
  return {
    id: "reasoning_effort",
    name: "Reasoning effort",
    description: current
      ? "Reasoning tier persisted by Letta for this session's model"
      : supported.length
        ? "Reasoning tier persisted by Letta is not one of its presets here; choose a listed tier to change it"
        : "Reasoning tier persisted by Letta is not one of its presets here; use /model to choose a Letta preset",
    category: "thought_level",
    type: "select",
    currentValue: effort,
    options,
  };
}
