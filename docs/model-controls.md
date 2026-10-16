# Model, reasoning effort, and context size: developer notes

The README describes what users see. This document records the contract the
adapter implements, why it has that shape, the runtime behavior it relies on,
and the evidence behind it. Code: `src/model-options.ts` (model menu),
`src/preset-grid.ts` (effort/context/preset selectors), `src/reasoning-options.ts`
(effort decoding, scoped state), `src/proxy-reasoning.ts` (proxy override), and
`src/agent.ts` (state, writes, queue, refresh).

## Source of truth

The model, effort, context, and preset selectors are catalog-backed: their
choices come from Letta's model catalog (`session.listModels()`), never from
adapter-side lists: one entry per preset id, with `handle` (exact provider
route) and `updateArgs` (`reasoning_effort`, `context_window`, and provider
settings). The adapter offers no free-form context size and no invented
effort/context combinations. The one exception is the generic requested-effort
override for explicitly marked proxy routes, described
[below](#requested-effort-for-explicitly-marked-proxy-routes).

### Model menu

- One option per exact handle. BYOK and provider-qualified routes stay separate;
  values are always the exact handle.
- The current route is listed first (T3 caps model lists at 256).
- An active route absent from the catalog is listed as `<handle> (current)`.
- Labels come from the catalog: a plain entry's label, else the shortest label
  of the route's first context family that every label of that family starts
  with at a word boundary, else `Model: <handle>`. A name is never blank and
  never equals its value: JetBrains Air (DataGrip plugin 262.8665.490) rejects
  the whole settings snapshot otherwise
  (`AirSessionPreferencesMetadataCache.kt`: `requireValid` /
  `invalidModelPresentation`), and the agent thread never becomes usable.
- Switching models keeps the current effort if the target offers it, else
  `medium`, else the first preset, in catalog order; the target's first matching
  preset decides the window. `/model <preset-id>` applies an exact preset.

### Effort and context: the preset grid

For a route (exact handle plus a BYOK provider alias's base presets), the
presets with an effort form a grid of effort x context window
(`presetGrid`). Effort uses Letta's persisted semantics: Anthropic
`enable_reasoner: false` is `none`; older Anthropic `xhigh` presets persist as
`max`. The preset a pair applies is the **first** in catalog order (the
runtime resolves ties the same way); later duplicates are ignored for
classification, e.g. a BYOK native entry cloned from the base preset, or a
`max` preset behind an `xhigh` one.

| Shape | Rule | Options |
|---|---|---|
| rectangular | every effort at every window; per effort, applied presets differ only in `context_window` (a single window counts) | `context_window` (listed first), `reasoning_effort` |
| sparse | some pair missing or applied presets differ beyond the window | one `letta_preset` select of real presets |
| windowless | no preset has a window | `reasoning_effort` only |
| none | no effort presets | nothing |

On Letta's cached cloud catalog (101 routes, 2026-10-15): 72 rectangular,
2 sparse (`anthropic/claude-opus-5`: 950K only at `high`;
`anthropic/claude-opus-4-8`: no `max` at 950K, no `none` at 200K), 27 none.

Why fixed lists: T3 (verified against its installed bundle) renders each config
option as a static list copied across all models, keeps the user's stored
selection over the reported value, and on send applies stored selections in
option order, each checked against **one** options snapshot taken after
setting the model; values missing from it are skipped silently and rejections
are only logged. Lists that depend on another option's current value therefore
cannot be satisfied before a turn. Separate lists are offered only where every
expressible pair is a real preset; sparse routes use one combined selector so a
client cannot store an impossible pair.

### Writes

- **Effort E** (rectangular): the exact preset (E, current window) if it exists;
  only from a window outside the presets, the first catalog preset for E. Context
  is listed before effort so a client sending both reaches the chosen pair
  without an intermediate preset.
- **Context W** (rectangular): with a preset tier, a context-only scoped update
  (`conversations.update` / `agents.update` for the default conversation, the
  same public update Letta's `/context-limit` makes). This matches the preset on
  the effort and window dimensions and leaves other saved settings untouched; it
  does not assert that externally customized settings equal the preset. With an
  unreported or non-preset tier, the first catalog preset at W is applied.
- **Preset** (sparse): the selected preset id.
- **Applying a preset** = `session.updateModel({ modelId, modelHandle })` with
  the exact id and current route, then re-read persisted state. Letta Code's
  preservation heuristic (`shouldPreserveContextWindowForModelSelection`,
  inferred from agent-level settings) can keep a previous window; if the saved
  window is not the preset's, a context-only write moves it to the preset's
  window, and the result is re-read again.
- **Two steps, not transactional.** If the correction fails, or a write cannot
  be confirmed, the adapter re-reads persisted state, sends a
  `config_option_update` with it, and returns a sanitized error. A timed-out
  write is not cancelled and may land after that re-read; reloading the session
  reconciles it.
- Unchanged values (including displayed non-preset or unreported state) are
  no-ops. Values outside the current lists are rejected.

### Displayed state that is not a choice

ACP requires `currentValue` to name an option. A persisted window outside the
presets (e.g. 1,050,000 where Luna's presets are 350K and 950K; a freshly
created bare-Luna agent defaults to this capacity), an unreported effort
(`unknown`, "Not reported"), a non-preset effort, or an off-grid pair
(`current`) is listed as current and labelled as such. Nothing is resized on
discovery; the entry cannot be reselected once left.

### State, queue, and refresh

- State is read fieldwise: route is the conversation model else the agent
  model; a settings-only conversation override applies to the agent route; a
  different conversation model inherits neither agent settings nor the agent
  window; otherwise the window is the conversation limit else the agent limit
  (legacy `llm_config` fallback).
- Model/effort/context mutations are serialized per session; a prompt waits for
  admitted mutations and rejects new ones while active. Permission mode changes
  stay live.
- After every prompt (turns and slash commands such as `/context-limit`) a
  refresh is queued on the same chain: it reads after earlier mutations, later
  mutations apply after it, a failed read keeps the last confirmed state, a
  displaced session never notifies, and `config_option_update` is sent only when
  the snapshot changed.
- The catalog is fetched once per session so a later catalog failure cannot turn
  an applied update into a failed request.

## Requested effort for explicitly marked proxy routes

When the exact active route is marked `updateArgs.openai_compatible_proxy: true`
with `provider_type: "openai"` and has at most one catalog effort tier, the
adapter shows `requested_reasoning_effort` instead: generic override requests
(`none` ... `max`, plus Default = JSON `null`), not a claim of upstream support.
It uses the public `session.sendCommand` with an `update_model` payload of the
exact advertised `model_id`, the exact `model_handle` from the same entry, and
`reasoning_effort`. Responses must confirm success, runtime, route, and the
persisted requested effort; errors are sanitized and release the queue. A
malformed, normalized, or timed-out acknowledgement triggers the same re-read
and notification as above (not transactional).

Limitations:

- Letta Code's `list_models` can decorate proxy metadata absent from its
  underlying `models2` catalog; handle-only updates can drop the effort. ID plus
  handle merges native inventory metadata only where that inventory supplies it.
  The true local harness (`listLocalModels`) does not, so the override is hidden
  and rejected for local SDK transport unless `appServer.harnessBackend` is
  `"api"` (`cloud-oauth`); remote and cloud are eligible.
- On cloud routes where the preset id equals the handle, the resolver can skip
  that merge; the adapter reports failure rather than borrowing another
  provider's preset.
- The command has no context override, so it requires a known positive window
  that matches the entry's window (or the entry has none), excluding an unmatched
  128000 legacy clamp.

References (installed Letta Code 0.34.14 `letta.js`):
`getByokOpenAIReasoningTierOptions`, `buildModelSettings` (`reasoning: null`
for reset), `buildListModelsResponse`, `resolveModelForUpdateBase`,
`resolveModelForUpdate`, `applyModelUpdateForRuntime`,
`resolveContextWindowForUpdate`. Agent SDK 0.8.44 exposes `sendCommand`; its
`updateModel({ reasoningEffort })` selects existing presets and cannot express
the raw override or reset.

## Evidence and tested versions

Versions: Agent SDK 0.8.44, Letta Code 0.34.14, ACP SDK 1.8.

| Evidence | Kind | What it shows |
|---|---|---|
| `bun run check`, `bun run test:acpx` | deterministic | fake app-server, real SDK transport and adapter stdio; includes a replay of T3's single-snapshot send |
| Scratch-agent runs, Mac, Bun, `cloud-oauth`, 2026-10-15 | live, no inference | Luna at 1.05M shows all six efforts and 350K/950K; High only ends on the 350K High preset (runtime kept 1.05M, correction applied); 950K + High in one snapshot ends on the 950K High preset; replay and reload write nothing (`updated_at` unchanged); Opus 5 shows the combined preset selector and applies `opus-5-1m` |
| T3 Code Nightly 0.0.46-nightly.20261014.3132 bundle | static source reading | option mapping, per-model copy, single-snapshot send |
| DataGrip 2026.2.6 (DB-262.10968.148), Air plugin 262.8665.490 | static bytecode + logs | model-name validation that broke the agent thread |
| Zed, T3, DataGrip | user-confirmed UI | selectors usable after deployment |
| Standalone JetBrains Air | user report | no generic effort/context controls rendered |

Not covered: Windows (Node) client rendering, and inference behavior at each
preset (no prompts were sent in the live checks).

## Live checks

The live scripts use real credentials and create agents; run them deliberately.

- `bun run test:backend:live:local` / `bun run test:backend:live:cloud`
  (`test/backend-live.ts`, used by CI on trusted pushes): create an agent, list
  models, and send one marker prompt.
- `npm run build && npm run test:backend:live:cloud-oauth`
  (`test/backend-cloud-oauth-live.mjs`): saved-login smoke under Node (the SDK
  launches its harness with the same Node executable). Run on a machine with an
  existing `letta login`; it performs no login or provider changes and does not
  read credentials. It removes `LETTA_API_KEY`/`LETTA_AGENT_ID` from its own
  environment, keeps HOME/keychain discovery, and uses a temporary cwd and ACP
  state directory. Default route `chatgpt-plus-pro/gpt-6-luna-fast`
  (`LETTA_ACP_SMOKE_MODEL` overrides). It checks catalog membership and account
  availability, ACP initialization, a new dedicated agent/session, the model
  configuration, `/model`, and one exact sentinel reply without tools (one small
  model request; may consume quota). Tool approvals are denied; the temporary
  cwd is not a sandbox. Cleanup deletes only the agent it created; a creation
  without a delivered id, forced termination, or failed deletion can leave a
  temporary agent, which it reports. Harness caches and saved-login refresh may
  still be updated. It exercises `cloud-oauth` only, not the API-key backends.
