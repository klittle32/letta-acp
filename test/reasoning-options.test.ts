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
    expect(reasoningOption(scoped, "xhigh")).toBeUndefined();
  });

  test("uses runtime preset inference for custom context and unions BYOK capabilities", () => {
    expect(reasoningEntries(entries.slice(0, 2), "openai/test", undefined, 200)).toEqual(entries.slice(0, 2));
    const byok = { ...entries[0]!, id: "byok-low", handle: "lc-openai/test" };
    expect(reasoningEntries([...entries, byok], byok.handle, { "lc-openai": "openai" }, 100))
      .toEqual([entries[0]!, entries[1]!, byok]);
    expect(reasoningEntries(entries, "openai/test", undefined, 200))
      .toEqual([entries[2]!]);
    expect(reasoningEntries(entries, "openai/test", undefined, 42000)).toEqual([]);
    expect(reasoningEntries(entries, "openai/test", undefined, 128000)).toEqual([]);
    expect(reasoningEntries(entries.slice(0, 2), "openai/test", undefined, 128000))
      .toEqual(entries.slice(0, 2));
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
