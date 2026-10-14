import { describe, expect, test } from "bun:test";
import {
  proxyOverrideAvailable, proxyOverrideBackendAvailable, proxyOverrideEntry, requestedEffort, requestedEffortOption,
} from "../src/proxy-reasoning.js";

const route = "litellm/xai/grok-4.7";
const entry = {
  id: route, handle: route, label: "Grok", description: "",
  updateArgs: { provider_type: "openai", openai_compatible_proxy: true },
};

describe("proxy reasoning override", () => {
  test("excludes true local harnesses but retains API, remote and cloud eligibility", () => {
    expect(proxyOverrideBackendAvailable({})).toBe(false);
    expect(proxyOverrideBackendAvailable({ backend: "local" })).toBe(false);
    expect(proxyOverrideBackendAvailable({ backend: "local", appServer: { harnessBackend: "local" } })).toBe(false);
    expect(proxyOverrideBackendAvailable({ backend: "local", appServer: { harnessBackend: "api" } })).toBe(true);
    expect(proxyOverrideBackendAvailable({ backend: "remote", url: "ws://fake-app-server.test/ws" })).toBe(true);
    expect(proxyOverrideBackendAvailable({ backend: "cloud" })).toBe(true);
  });

  test("selects the same exact advertised entry for metadata, context and payload identity", () => {
    const selected = {
      ...entry, id: "inventory-proxy-preset",
      updateArgs: { ...entry.updateArgs, context_window: 256_000 },
    };
    const direct = {
      ...selected, id: "direct-provider-preset", handle: "xai/grok-4.7",
    };
    expect(proxyOverrideEntry([direct, selected], route, 256_000)).toBe(selected);
    expect(proxyOverrideEntry([direct, selected], route, 64_000)).toBeUndefined();
    // Do not authorize with a later entry then submit the first entry's ID.
    const unsafe = { ...selected, id: "unsafe", updateArgs: { provider_type: "openai" } };
    expect(proxyOverrideEntry([unsafe, selected], route, 256_000)).toBeUndefined();
  });

  test("requires explicit exact-route proxy metadata and a preservable actual context", () => {
    expect(proxyOverrideAvailable([entry], route, 256_000)).toBe(true);
    expect(proxyOverrideAvailable([entry], route, undefined)).toBe(false);
    expect(proxyOverrideAvailable([entry], route, 128_000)).toBe(false);
    expect(proxyOverrideAvailable([entry], "xai/grok-4.7", 256_000)).toBe(false);
    for (const updateArgs of [{}, { provider_type: "openai" }, { openai_compatible_proxy: true },
      { provider_type: "anthropic", openai_compatible_proxy: true }]) {
      expect(proxyOverrideAvailable([{ ...entry, updateArgs }], route, 256_000)).toBe(false);
    }
    const withWindow = (context_window: number) => ({
      ...entry, updateArgs: { ...entry.updateArgs, context_window },
    });
    expect(proxyOverrideAvailable([withWindow(256_000)], route, 256_000)).toBe(true);
    expect(proxyOverrideAvailable([withWindow(128_000)], route, 128_000)).toBe(true);
    expect(proxyOverrideAvailable([withWindow(256_000)], route, 64_000)).toBe(false);
  });

  test("retains adequate exact catalog tiers and does not borrow a direct-provider preset", () => {
    const tiers = ["low", "high"].map((effort) => ({
      ...entry, id: effort, updateArgs: { ...entry.updateArgs, reasoning_effort: effort },
    }));
    expect(proxyOverrideAvailable(tiers, route, 256_000)).toBe(false);
    expect(proxyOverrideAvailable([
      { ...entry, handle: "xai/grok-4.7", updateArgs: { reasoning_effort: "high", context_window: 1_000_000 } },
      entry,
    ], route, 64_000)).toBe(true);
  });

  test("explicit default differs from missing, malformed or unavailable settings", () => {
    expect(requestedEffort({ reasoning: null })).toBe("default");
    expect(requestedEffort({ reasoning: { reasoning_effort: "max" } })).toBe("max");
    for (const settings of [{}, { reasoning: {} }, { reasoning: { reasoning_effort: null } },
      { reasoning: "bad" }, { effort: null }]) {
      expect(requestedEffort(settings)).toBeUndefined();
    }
    expect(requestedEffortOption(undefined)).toMatchObject({
      currentValue: "unknown",
      options: expect.arrayContaining([{ value: "unknown", name: "Unknown (not reported)" }]),
    });
    expect(requestedEffortOption("default")).toMatchObject({ currentValue: "default" });
  });
});
