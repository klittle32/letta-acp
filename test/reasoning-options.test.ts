import { describe, expect, test } from "bun:test";
import {
  effectiveEffort, presetEffort, reasoningEntries, reasoningOption, scopedModelSnapshot,
} from "../src/reasoning-options.js";

const entries = [
  { id: "low", handle: "openai/test", label: "Low", description: "", updateArgs: { reasoning_effort: "low", context_window: 100 } },
  { id: "high", handle: "openai/test", label: "High", description: "", updateArgs: { reasoning_effort: "high", context_window: 100 } },
  { id: "large", handle: "openai/test", label: "Large", description: "", updateArgs: { reasoning_effort: "xhigh", context_window: 200 } },
  { id: "max", handle: "anthropic/test", label: "Max", description: "", updateArgs: { reasoning_effort: "max" } },
];

describe("reasoning settings", () => {
  test("disabled thinking clears all inherited effort representations", () => {
    const snapshot = scopedModelSnapshot({
      model: "anthropic/test",
      model_settings: { effort: "high" },
      llm_config: { reasoning_effort: "high", reasoning: { reasoning_effort: "high" } },
    }, { model: "anthropic/test", model_settings: { thinking: { type: "disabled" } } });
    expect(effectiveEffort(snapshot.settings, snapshot.legacy)).toBe("none");
    expect(snapshot.settings).toEqual({ thinking: { type: "disabled" } });
  });

  test("catalog tiers use persisted Anthropic semantics and order max last", () => {
    const preset = (handle: string, effort: string) => ({
      id: effort, handle, label: effort, description: "", updateArgs: { reasoning_effort: effort },
    });
    expect(presetEffort(preset("anthropic/claude-opus-4-6", "xhigh"))).toBe("max");
    expect(presetEffort(preset("bedrock/claude-opus-4-6", "xhigh"))).toBe("max");
    expect(presetEffort(preset("anthropic/claude-opus-4-7", "xhigh"))).toBe("xhigh");
    expect(presetEffort(preset("openai/test", "xhigh"))).toBe("xhigh");
    const tiers = ["max", "xhigh", "high"].map((effort) => preset("anthropic/claude-opus-4-7", effort));
    expect(reasoningOption(tiers, "max")).toMatchObject({
      currentValue: "max",
      options: ["high", "xhigh", "max"].map((value) => ({ value, name: value })),
    });
  });
  test("reads provider settings and legacy explicit values without inventing defaults", () => {
    expect(effectiveEffort({ reasoning: { reasoning_effort: "high" } })).toBe("high");
    expect(effectiveEffort({ effort: "low" })).toBe("low");
    expect(effectiveEffort({}, { reasoning_effort: "medium" })).toBe("medium");
    expect(effectiveEffort({}, { enable_reasoner: false })).toBe("none");
    expect(effectiveEffort({ effort: "max" })).toBe("max");
    for (const settings of [{}, { reasoning: null }, { effort: null }]) {
      expect(effectiveEffort(settings)).toBeUndefined();
    }
    expect(effectiveEffort({ reasoning: null }, { reasoning_effort: "high" })).toBeUndefined();
    expect(effectiveEffort({ effort: null }, { reasoning_effort: "high" })).toBeUndefined();
  });

  test("inherits same-model settings but not another model's reasoning", () => {
    const agent = {
      model: "openai/test",
      model_settings: { reasoning: { reasoning_effort: "high" } },
      llm_config: { context_window: 100 },
    };
    expect(effectiveEffort(scopedModelSnapshot(agent).settings)).toBe("high");
    expect(effectiveEffort(scopedModelSnapshot(agent, { model: "openai/test" }).settings)).toBe("high");
    const changed = scopedModelSnapshot(agent, { model: "anthropic/test" });
    expect(effectiveEffort(changed.settings, changed.legacy)).toBeUndefined();
    expect(changed.contextWindow).toBeUndefined();
    const override = scopedModelSnapshot(agent, {
      model: "openai/test", model_settings: { reasoning: { reasoning_effort: "low" } },
    });
    expect(effectiveEffort(override.settings)).toBe("low");
    expect(override.contextWindow).toBe(100);
  });

  test("uses catalog capabilities, BYOK aliases and context variants", () => {
    expect(reasoningEntries(entries, "custom/test")).toEqual([]);
    expect(reasoningEntries(entries, "openai/test")).toEqual([]);
    expect(reasoningEntries(entries, "lc-openai/test", { "lc-openai": "openai" }, 100)
      .map((entry) => entry.id)).toEqual(["low", "high"]);
    expect(reasoningEntries(entries, "anthropic/test")).toEqual([entries[3]!]);
    const scoped = reasoningEntries(entries, "openai/test", undefined, 100);
    expect(reasoningOption(scoped, "high")).toMatchObject({
      id: "reasoning_effort", category: "thought_level", currentValue: "high",
      options: [{ value: "low", name: "low" }, { value: "high", name: "high" }],
    });
    expect(reasoningOption(scoped, undefined)).toBeUndefined();
    // A known effort without an applicable preset is displayed, not offered.
    expect(reasoningOption(scoped, "medium")).toMatchObject({
      currentValue: "medium",
      description: expect.stringContaining("choose a listed tier"),
      options: [
        { value: "low", name: "low" },
        { value: "medium", name: "medium (current, not a Letta preset here)" },
        { value: "high", name: "high" },
      ],
    });
    expect(reasoningOption([], "low")).toMatchObject({
      currentValue: "low",
      description: expect.stringContaining("use /model"),
      options: [{ value: "low", name: "low (current, not a Letta preset here)" }],
    });
  });

  test("windowless presets are not offered at the legacy 128000 clamp unless a 128000 family exists", () => {
    const windowless = entries.slice(3);
    expect(reasoningEntries(windowless, "anthropic/test", undefined, 128000)).toEqual([]);
    expect(reasoningEntries(windowless, "anthropic/test", undefined, 127999)).toEqual(windowless);
    const clamp = { ...entries[3]!, id: "clamp", updateArgs: { reasoning_effort: "high", context_window: 128000 } };
    expect(reasoningEntries([...windowless, clamp], "anthropic/test", undefined, 128000)).toEqual([clamp]);
  });

  test("offers effort presets only at the actual window and unions BYOK capabilities", () => {
    const byok = { ...entries[0]!, id: "byok-low", handle: "lc-openai/test" };
    expect(reasoningEntries([...entries, byok], byok.handle, { "lc-openai": "openai" }, 100))
      .toEqual([entries[0]!, entries[1]!, byok]);
    expect(reasoningEntries(entries, "openai/test", undefined, 200))
      .toEqual([entries[2]!]);
    // Off-preset and unknown windows: any effort preset would also resize.
    for (const window of [42000, 128000, undefined]) {
      expect(reasoningEntries(entries, "openai/test", undefined, window)).toEqual([]);
      expect(reasoningEntries(entries.slice(0, 2), "openai/test", undefined, window)).toEqual([]);
    }
    // Presets without a window never resize, whatever the actual window is.
    expect(reasoningEntries(entries, "anthropic/test", undefined, 42000)).toEqual([entries[3]!]);
  });

  test("settings-only conversation overrides apply to the agent route", () => {
    const agent = {
      model: "chatgpt-plus-pro/gpt-6-luna",
      model_settings: { provider_type: "chatgpt_oauth", reasoning: { reasoning_effort: "high" } },
      llm_config: { reasoning_effort: "high", context_window: 350000 },
      context_window_limit: 350000,
    };
    const settingsOnly = scopedModelSnapshot(agent, {
      model: null,
      model_settings: { provider_type: "chatgpt_oauth", reasoning: { reasoning_effort: "low" } },
      context_window_limit: 1050000,
    });
    expect(settingsOnly.model).toBe(agent.model);
    expect(effectiveEffort(settingsOnly.settings, settingsOnly.legacy)).toBe("low");
    expect(settingsOnly.contextWindow).toBe(1050000);
    const contextOnly = scopedModelSnapshot(agent, { model: null, model_settings: null, context_window_limit: 950000 });
    expect(effectiveEffort(contextOnly.settings, contextOnly.legacy)).toBe("high");
    expect(contextOnly.contextWindow).toBe(950000);
    const empty = scopedModelSnapshot(agent, { model: null, model_settings: null, context_window_limit: null });
    expect(empty).toEqual(scopedModelSnapshot(agent));
    expect(empty.contextWindow).toBe(350000);
    const reset = scopedModelSnapshot(agent, { model: null, model_settings: { reasoning: null } });
    expect(effectiveEffort(reset.settings, reset.legacy)).toBeUndefined();
  });

  test("scoped null clears inherited legacy and provider effort representations", () => {
    const agent = {
      model: "openai/test", model_settings: { reasoning: { reasoning_effort: "high" } },
      llm_config: { reasoning_effort: "high", enable_reasoner: false },
    };
    for (const model_settings of [
      { reasoning_effort: null }, { effort: null }, { reasoning: null },
    ]) {
      const state = scopedModelSnapshot(agent, { model: agent.model, model_settings });
      expect(effectiveEffort(state.settings, state.legacy)).toBeUndefined();
    }
  });
});
