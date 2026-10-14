import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { LettaCodeClientOptions, LettaCodeModelEntry, LettaCodeSession } from "@letta-ai/letta-agent-sdk";
import { effectiveEffort, isReasoningEffort, presetEffort, type ReasoningEffort } from "./reasoning-options.js";

export const REQUESTED_EFFORT_ID = "requested_reasoning_effort";
export type RequestedEffort = ReasoningEffort | "default";

/** Local inventory lacks the metadata needed to preserve raw proxy overrides. */
export function proxyOverrideBackendAvailable(options: LettaCodeClientOptions): boolean {
  return (options.backend !== undefined && options.backend !== "local") ||
    options.appServer?.harnessBackend === "api";
}

/** Only an explicit persisted null means reset; missing settings are unknown. */
export function requestedEffort(settings: Record<string, unknown>): RequestedEffort | undefined {
  if (Object.hasOwn(settings, "reasoning") && settings.reasoning === null) return "default";
  return effectiveEffort(settings);
}

/**
 * Do not canonicalize routes or borrow direct-provider presets. The runtime's
 * ID plus handle update resolves the selected preset and native inventory,
 * but still requires proxy metadata in that inventory. Backend eligibility
 * must be checked separately; decorated selector metadata alone is insufficient.
 * Without a context override on that public command, require a known window
 * that the runtime will preserve, not merely an advertised maximum.
 */
export function proxyOverrideAvailable(
  entries: LettaCodeModelEntry[],
  handle: string | undefined,
  contextWindow: number | undefined,
): boolean {
  return proxyOverrideEntry(entries, handle, contextWindow) !== undefined;
}

/** Return the very entry whose metadata and context authorize the update. */
export function proxyOverrideEntry(
  entries: LettaCodeModelEntry[],
  handle: string | undefined,
  contextWindow: number | undefined,
): LettaCodeModelEntry | undefined {
  if (!handle || !contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  const exact = entries.filter((entry) => entry.handle === handle);
  const selected = exact[0];
  const args = selected?.updateArgs;
  if (!selected?.id || args?.openai_compatible_proxy !== true || args.provider_type !== "openai") return undefined;
  if (new Set(exact.map(presetEffort).filter((effort) => effort !== undefined)).size > 1) return undefined;
  // The runtime treats 128000 specially as a legacy clamp. Do not rely on its
  // preservation heuristic; an exact selected window is still safe.
  return args.context_window === contextWindow ||
    (args.context_window === undefined && contextWindow !== 128_000) ? selected : undefined;
}

export function requestedEffortOption(current: RequestedEffort | undefined): SessionConfigOption {
  return {
    id: REQUESTED_EFFORT_ID,
    name: "Requested reasoning effort",
    description: "OpenAI-compatible proxy override; upstream support is not confirmed. Default resets the override.",
    category: "thought_level",
    type: "select",
    currentValue: current ?? "unknown",
    options: [
      ...(current === undefined ? [{ value: "unknown", name: "Unknown (not reported)" }] : []),
      { value: "default", name: "Default (reset override)" },
      ...["none", "minimal", "low", "medium", "high", "xhigh", "max"]
        .map((value) => ({ value, name: value })),
    ],
  };
}

/** Public SDK control transport supplies request IDs, correlation and timeout. */
export async function updateProxyEffort(
  session: LettaCodeSession,
  entry: LettaCodeModelEntry,
  effort: RequestedEffort,
): Promise<Record<string, unknown>> {
  const handle = entry.handle;
  const runtime = { agent_id: session.agentId, conversation_id: session.conversationId };
  const response = await session.sendCommand({
    type: "update_model",
    runtime,
    payload: { model_id: entry.id, model_handle: handle, reasoning_effort: effort === "default" ? null : effort },
  }, {
    // Include protocol errors so they fail promptly instead of timing out.
    predicate: (message) => message.type === "update_model_response" || message.type === "error",
  });
  const scope = response.runtime as typeof runtime | undefined;
  const settings = response.model_settings;
  if (response.type !== "update_model_response" || response.success !== true ||
      response.model_handle !== handle ||
      !scope || scope.agent_id !== runtime.agent_id || scope.conversation_id !== runtime.conversation_id ||
      response.applied_to !== (runtime.conversation_id === "default" ? "agent" : "conversation") ||
      !settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("Invalid proxy model update response");
  }
  const confirmed = requestedEffort(settings as Record<string, unknown>);
  if (confirmed !== effort || (confirmed !== "default" && !isReasoningEffort(confirmed))) {
    throw new Error("Proxy model update did not confirm the requested effort");
  }
  return settings as Record<string, unknown>;
}
