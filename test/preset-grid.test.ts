import { describe, expect, test } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { LettaCodeModelEntry } from "@letta-ai/letta-agent-sdk";
import {
  contextOption, effortOption, effortTarget, formatTokens, presetGrid, presetOption,
} from "../src/preset-grid.js";
import { modelOptions } from "../src/model-options.js";

const preset = (handle: string, id: string, effort: string, window: number | undefined, extra = {}): LettaCodeModelEntry => ({
  id, handle, label: id, description: "",
  updateArgs: { reasoning_effort: effort, ...(window === undefined ? {} : { context_window: window }), ...extra },
});
const choices = (option: SessionConfigOption | undefined) =>
  (option as { options?: Array<{ value: string; name: string }> } | undefined)?.options;
const LUNA = "chatgpt-plus-pro/gpt-6-luna";
const luna = [350_000, 950_000].flatMap((window) => ["none", "low", "high"].map((effort) =>
  preset(LUNA, `${window}-${effort}`, effort, window, { verbosity: "low" })));
// Shapes from Letta's cached live catalog (the only two sparse routes there).
const opus5 = [
  ...["low", "medium", "high", "xhigh", "max"].map((effort) => preset("anthropic/claude-opus-5", `opus-5-${effort}`, effort, 200_000)),
  preset("anthropic/claude-opus-5", "opus-5-1m", "high", 950_000),
];
const opus48 = [200_000, 950_000].flatMap((window) => ["none", "high", "max"]
  .filter((effort) => !(effort === "none" && window === 200_000) && !(effort === "max" && window === 950_000))
  .map((effort) => preset("anthropic/claude-opus-4-8", `${window}-${effort}`, effort, window)));

describe("Letta preset grid", () => {
  test("classifies route shapes from the catalog alone", () => {
    expect(presetGrid(luna, LUNA)).toMatchObject({ kind: "rectangular", efforts: ["none", "low", "high"], windows: [350_000, 950_000] });
    expect(presetGrid(luna.slice(0, 3), LUNA)).toMatchObject({ kind: "rectangular", windows: [350_000] });
    expect(presetGrid(opus5, "anthropic/claude-opus-5").kind).toBe("sparse");
    expect(presetGrid(opus48, "anthropic/claude-opus-4-8").kind).toBe("sparse");
    const divergent = luna.map((entry) => entry.id === "950000-low"
      ? { ...entry, updateArgs: { ...entry.updateArgs, verbosity: "medium" } } : entry);
    expect(presetGrid(divergent, LUNA).kind).toBe("sparse");
    expect(presetGrid([preset("openai/x", "x-low", "low", undefined)], "openai/x").kind).toBe("windowless");
    expect(presetGrid([{ id: "plain", handle: "openai/x", label: "X", description: "" }], "openai/x").kind).toBe("none");
    expect(presetGrid(luna, "lc-chatgpt/gpt-6-luna", { "lc-chatgpt": "chatgpt-plus-pro" }).kind).toBe("rectangular");
    expect(presetGrid(luna, "lc-chatgpt/gpt-6-luna").kind).toBe("none");
  });

  test("only the preset each pair applies decides the shape, not never-selected duplicates", () => {
    // Letta Code's buildNativeModelEntry: a BYOK native route clones the base
    // route's first matching preset and adds inventory metadata (id == handle).
    const byok = "lc-chatgpt/gpt-6-luna";
    const native: LettaCodeModelEntry = {
      id: byok, handle: byok, label: "GPT-6 Luna", description: "",
      updateArgs: { ...luna[0]!.updateArgs, provider_type: "chatgpt_oauth" },
    };
    const aliases = { "lc-chatgpt": "chatgpt-plus-pro" };
    expect(presetGrid([...luna, native], byok, aliases))
      .toMatchObject({ kind: "rectangular", efforts: ["none", "low", "high"], windows: [350_000, 950_000] });
    // Older Anthropic models persist xhigh as max: the later max preset is never selected.
    const HAIKU = "anthropic/claude-haiku-5-5";
    const haiku = [200_000, 1_000_000].flatMap((window) => [
      preset(HAIKU, `${window}-high`, "high", window),
      preset(HAIKU, `${window}-xhigh`, "xhigh", window, { max_reasoning_tokens: 32_000 }),
      preset(HAIKU, `${window}-max`, "max", window),
    ]);
    const grid = presetGrid(haiku, HAIKU);
    expect(grid).toMatchObject({ kind: "rectangular", efforts: ["high", "max"], windows: [200_000, 1_000_000] });
    if (grid.kind !== "rectangular") throw new Error("expected rectangular");
    expect(effortTarget(grid, "max", 1_000_000).id).toBe("1000000-xhigh");
    // Presets that are actually applied and differ beyond the window stay sparse.
    const divergent = haiku.map((entry) => entry.id === "1000000-xhigh"
      ? { ...entry, updateArgs: { ...entry.updateArgs, max_reasoning_tokens: 64_000 } } : entry);
    expect(presetGrid(divergent, HAIKU).kind).toBe("sparse");
  });

  test("effort keeps the window when Letta has that pair, else takes the first catalog preset", () => {
    const grid = presetGrid(luna, LUNA);
    if (grid.kind !== "rectangular") throw new Error("expected rectangular");
    expect(effortTarget(grid, "high", 950_000).id).toBe("950000-high");
    expect(effortTarget(grid, "high", 1_050_000).id).toBe("350000-high");
    expect(effortTarget(grid, "high", undefined).id).toBe("350000-high");
  });

  test("rectangular options list every real tier and window beside truthful current state", () => {
    const grid = presetGrid(luna, LUNA);
    if (grid.kind !== "rectangular") throw new Error("expected rectangular");
    expect(choices(contextOption(grid, 1_050_000))).toEqual([
      { value: "350000", name: "350K tokens" }, { value: "950000", name: "950K tokens" },
      { value: "1050000", name: "1.05M tokens (current, not a Letta preset)" },
    ]);
    expect(contextOption(grid, undefined)).toBeUndefined();
    const single = presetGrid(luna.slice(0, 3), LUNA);
    if (single.kind !== "rectangular") throw new Error("expected rectangular");
    expect(contextOption(single, 350_000)).toBeUndefined();
    expect(choices(contextOption(single, 1_050_000))?.map((option) => option.value)).toEqual(["350000", "1050000"]);
    expect(effortOption(grid, "low", 350_000)).toMatchObject({
      currentValue: "low", description: expect.stringContaining("keeps the context size"),
      options: ["none", "low", "high"].map((value) => ({ value, name: value })),
    });
    expect(effortOption(grid, "medium", 1_050_000)).toMatchObject({
      currentValue: "medium", description: expect.stringContaining("moves the context size"),
      options: [
        { value: "none", name: "none" }, { value: "low", name: "low" },
        { value: "medium", name: "medium (current, not a Letta preset for this model)" },
        { value: "high", name: "high" },
      ],
    });
    expect(effortOption(grid, undefined, 350_000)).toMatchObject({
      currentValue: "unknown", options: [{ value: "unknown", name: "Not reported" }, { value: "none" }, { value: "low" }, { value: "high" }],
    });
  });

  test("sparse routes offer only real presets", () => {
    const grid = presetGrid(opus48, "anthropic/claude-opus-4-8");
    if (grid.kind !== "sparse") throw new Error("expected sparse");
    expect(presetOption(grid, "high", 950_000)).toMatchObject({
      currentValue: "950000-high",
      options: [
        { value: "200000-high", name: "high · 200K tokens" },
        { value: "200000-max", name: "max · 200K tokens" },
        { value: "950000-none", name: "none · 950K tokens" },
        { value: "950000-high", name: "high · 950K tokens" },
      ],
    });
    expect(choices(presetOption(grid, undefined, undefined))?.[0])
      .toEqual({ value: "current", name: "effort not reported (current, not a Letta preset)" });
  });

  test("formats token counts without rounding away precision", () => {
    expect([350_000, 950_000, 1_000_000, 1_050_000, 1_234_567, 42_500].map(formatTokens))
      .toEqual(["350K", "950K", "1M", "1.05M", "1,234,567", "42,500"]);
  });

  test("names a route by its first context family when families are labelled apart", () => {
    const labelled = opus5.map((entry) => ({ ...entry, label: entry.id === "opus-5-1m" ? "Opus 5 1M" : "Opus 5" }));
    expect(modelOptions(labelled)).toEqual([{ value: "anthropic/claude-opus-5", name: "Opus 5" }]);
  });
});
