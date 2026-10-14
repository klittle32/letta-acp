import { describe, expect, test } from "bun:test";
import { modelHandle, modelOptions, modelSelection } from "../src/model-options.js";
import { reasoningEntries, reasoningOption } from "../src/reasoning-options.js";

const entries = [
  { id: "low", handle: "openai/test", label: "Test (low)", description: "", updateArgs: { reasoning_effort: "low", context_window: 100 } },
  { id: "high", handle: "openai/test", label: "Test (high)", description: "", isDefault: true, updateArgs: { reasoning_effort: "high", context_window: 100 } },
  { id: "large", handle: "openai/test", label: "Test (high, large)", description: "", updateArgs: { reasoning_effort: "high", context_window: 200 } },
  { id: "byok", handle: "lc-openai/test", label: "Test", description: "" },
  { id: "other", handle: "other/test", label: "Other test", description: "" },
];

describe("grouped model choices", () => {
  test("deduplicates exact handles, retaining provider and BYOK routes and raw efforts", () => {
    expect(modelOptions(entries)).toEqual([
      { value: "openai/test", name: "openai/test" },
      { value: "lc-openai/test", name: "Test" },
      { value: "other/test", name: "Other test" },
    ]);
    expect(reasoningOption(reasoningEntries(entries, "openai/test", undefined, 100), "high"))
      .toMatchObject({ options: [{ value: "low", name: "low" }, { value: "high", name: "high" }] });
    expect(entries).toHaveLength(5);
  });

  test("resolves presets to stable handles and leaves custom/BYOK handles alone", () => {
    expect(modelHandle(entries, "large")).toBe("openai/test");
    expect(modelHandle(entries, "lc-openai/test")).toBe("lc-openai/test");
    expect(modelHandle(entries, "custom/test")).toBe("custom/test");
    expect(modelSelection(entries, "openai/test", {
      model: "large", settings: {}, contextWindow: 200,
    })).toBeUndefined();
  });

  test("preserves effort without requiring the old model's context on the target", () => {
    for (const catalog of [entries]) {
      expect(modelSelection(catalog, "openai/test", {
        model: "other/test", settings: { effort: "low" }, contextWindow: 100,
      })).toEqual({ modelId: "low", modelHandle: "openai/test" });
      expect(modelSelection(catalog, "openai/test", {
        model: "other/test", settings: { effort: "high" }, contextWindow: 200,
      })).toEqual({ modelId: "high", modelHandle: "openai/test" });
    }
    expect(modelSelection(entries, "openai/test", { settings: {} }))
      .toEqual({ modelId: "low", modelHandle: "openai/test" });
    expect(modelSelection(entries, "openai/test", { settings: {}, contextWindow: 300 }))
      .toEqual({ modelId: "low", modelHandle: "openai/test" });
  });

  test("uses target default for unsupported effort; permits a different single target context", () => {
    const singleWindow = entries.filter((entry) => entry.id !== "large");
    expect(modelSelection(singleWindow, "openai/test", {
      settings: { effort: "xhigh" }, contextWindow: 200,
    })).toEqual({ modelId: "low", modelHandle: "openai/test" });
    expect(modelSelection(singleWindow.map((entry) => ({ ...entry, isDefault: false })),
      "openai/test", { settings: {} })).toEqual({ modelId: "low", modelHandle: "openai/test" });
    expect(modelSelection(entries, "large", { settings: {} })).toBe("large");
    expect(modelSelection(entries, "custom/test", { settings: {} })).toBe("custom/test");
  });

  test("realistic preset-only catalog uses medium and consistent friendly metadata", () => {
    // Shape of the installed runtime catalog: no plain entry or isDefault,
    // repeated labels, context variants, and a single BYOK representative.
    const catalog = [272000, 1050000].flatMap((context_window) =>
      ["none", "low", "medium", "high", "xhigh"].map((reasoning_effort) => ({
        id: `gpt-5.4-${context_window}-${reasoning_effort}`,
        handle: "openai/gpt-5.4", label: "GPT-5.4", description: "OpenAI flagship",
        updateArgs: { context_window, reasoning_effort },
      })));
    catalog.push({ ...catalog[0]!, id: "byok-gpt-5.4", handle: "lc-openai/gpt-5.4" });
    const aliases = { "lc-openai": "openai" };
    expect(modelOptions(catalog)).toHaveLength(2);
    expect(modelOptions(catalog)[0]).toEqual({
      value: "openai/gpt-5.4", name: "GPT-5.4", description: "OpenAI flagship",
    });
    for (const option of modelOptions(catalog)) {
      expect(modelSelection(catalog, option.value, {
        model: "letta/auto", settings: {}, contextWindow: 128000,
      }, aliases)).toEqual({
        modelId: "gpt-5.4-272000-medium", modelHandle: option.value,
      });
      expect(modelSelection(catalog, option.value, {
        model: "letta/auto", settings: { effort: "high" }, contextWindow: 128000,
      }, aliases)).toEqual({
        modelId: "gpt-5.4-272000-high", modelHandle: option.value,
      });
    }
  });
});
