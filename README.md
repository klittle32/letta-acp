# letta-acp

An [Agent Client Protocol](https://agentclientprotocol.com) (ACP) adapter for
Letta. It exposes a stateful Letta agent as an ACP agent over stdio, so any ACP
client — Zed, JetBrains, marimo, or the bundled test client — can drive it.

Built on [`@letta-ai/letta-agent-sdk`](https://github.com/letta-ai/letta-agent-sdk)
(agent/session management, streaming, tool approvals) and
[`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk)
(protocol plumbing).

## Quick start

Install from npm:

```bash
npm install -g @letta-ai/letta-acp   # provides the `letta-acp` command
# or run it without installing:
npx -y @letta-ai/letta-acp
```

Or work from source:

```bash
git clone git@github.com:letta-ai/letta-acp.git
cd letta-acp
bun install

# smoke test with the bundled ACP client (spawns the agent over stdio)
bun test-client.ts
bun test-client.ts "List the files in this directory using your tools."
```

Without `LETTA_AGENT_ID`, the first session creates a visible, globally
unpinned agent named **Letta** using `letta/auto`, then logs its id to stderr.
Set `LETTA_AGENT_ID` to that value when future adapter processes should reuse
the same persistent memory.

### Test the ACP boundary

```bash
# deterministic: acpx → adapter stdio → fake Letta app server
bun run test:acpx

# live transport: acpx → adapter stdio → Letta Cloud
LETTA_API_KEY=... LETTA_ACP_TEST_AGENT_ID=agent-... bun run test:acpx:live
```

The deterministic test uses the published `acpx` CLI and this adapter's real
stdio entrypoint to verify a complete tool-call lifecycle without credentials
or an LLM. It is part of the normal `bun test` suite and runs on every pull
request. Trusted pushes to `main` also run the live transport check against a
dedicated Letta Cloud agent. That check creates a real session but deliberately
skips the model turn, so it verifies authentication and session creation
without spending model tokens.

## Use from Zed

Add to Zed's `settings.json`:

```json
{
  "agent_servers": {
    "Letta": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "@letta-ai/letta-acp"],
      "env": { "LETTA_AGENT_ID": "agent-..." }
    }
  }
}
```

(From a source checkout, use `"command": "/path/to/bun"`,
`"args": ["/path/to/letta-acp/src/index.ts"]` instead — use the full path
to `bun`, e.g. `~/.bun/bin/bun`, since Zed may not have it on its PATH.)

Then open the Agent Panel, click the **+** button (or the dropdown arrow next
to it), and choose **Letta** from the external agents list to start a thread.

To drive a **Letta Cloud** agent from Zed without putting an API key in
`settings.json`, run `letta login` once and use the
[`cloud-oauth`](#letta-cloud-via-oauth-cloud-oauth) backend:

```json
"env": {
  "LETTA_ACP_BACKEND": "cloud-oauth",
  "LETTA_AGENT_ID": "agent-..."
}
```

## Configuration

The adapter reaches Letta through one of four backends, selected with
`LETTA_ACP_BACKEND` ([self-hosting docs](https://docs.letta.com/self-hosting)).
Each subsection below shows the full `env` block for that backend.

### Letta Cloud (`cloud`)

Agents run on Letta's hosted platform; the harness executes in a cloud
sandbox. Get an API key at
[platform.letta.com/api-keys](https://platform.letta.com/api-keys):

```json
"env": {
  "LETTA_ACP_BACKEND": "cloud",
  "LETTA_API_KEY": "sk-let-...",
  "LETTA_AGENT_ID": "agent-..."
}
```

### Letta Cloud via OAuth (`cloud-oauth`)

Same cloud agents as `cloud`, but authenticated with your existing
`letta login` session instead of an API key — so no long-lived secret has to
be pasted into your editor's settings file.

```json
"env": {
  "LETTA_ACP_BACKEND": "cloud-oauth",
  "LETTA_AGENT_ID": "agent-..."
}
```

Run `letta login` once, then start a thread. ACP clients with terminal-auth
support can also launch this login flow directly from the agent setup UI.
Credentials are resolved by the letta-code harness exactly as the CLI does it:
OAuth tokens from your OS
keychain (macOS Keychain, Windows Credential Manager, libsecret), refreshed
automatically as they expire, falling back to `LETTA_API_KEY` if one is set.

Mechanically this is the `local` backend with the harness pointed at Letta
Cloud (`harnessBackend: "api"`): the SDK spawns a loopback app-server on your
machine, the agent and its memory live in Cloud (real `agent-*` ids, cloud-side
models), and — unlike `cloud` — built-in tools such as `Read` and `Bash`
execute against **your** filesystem rather than a cloud sandbox. For editor use
that's usually what you want.

### Local runtime (`local`, default)

The SDK spawns a private Letta Code app-server on your machine
(`letta.js --backend local app-server`); all agent state stays on-device under
`~/.letta/lc-local-backend`. Requires the `@letta-ai/letta-code` CLI to be
available (it ships as a dependency of this package) and model access: either
`letta login`, or connect providers directly —
`letta --backend local connect anthropic --api-key ...`, `connect ollama`, etc.

```json
"env": {
  "LETTA_ACP_BACKEND": "local",
  "LETTA_AGENT_ID": "agent-local-..."
}
```

Both entries are optional: `local` is the default backend, and without
`LETTA_AGENT_ID` the adapter creates a visible, globally unpinned **Letta** agent
on first use and logs its id to stderr. Set the logged id explicitly when later
adapter processes should return to that agent's persistent memory.

### Self-hosted app server (`remote`)

Point the adapter at an app server you run
(`letta server --backend local --listen ws://127.0.0.1:4500`). For
non-loopback deployments enable auth
(`--ws-auth capability-token --ws-token-file <path>`):

```json
"env": {
  "LETTA_ACP_BACKEND": "remote",
  "LETTA_APP_SERVER_URL": "ws://your-host:4500",
  "LETTA_APP_SERVER_TOKEN": "<capability token, if enabled>",
  "LETTA_AGENT_ID": "agent-..."
}
```

### All backends

| Variable | Effect |
|----------|--------|
| `LETTA_AGENT_ID` | reuse an existing agent instead of creating a visible, globally unpinned agent named `Letta` |
| `LETTA_ACP_MODEL` | optional model override for sessions, as a `provider/model` handle (e.g. `anthropic/claude-fable-5`, `openai/gpt-4.1`); new agents default to `letta/auto`, while reused agents keep their model when this is unset — run `/model` to list valid handles |
| `LETTA_ACP_PERMISSION_MODE` | initial session mode: `standard` (default), `acceptEdits`, `unrestricted` — switchable live via `session/set_mode` (Zed's mode dropdown) |

Note on tool execution: with `remote` and `cloud`, built-in tools (Read, Bash,
…) run where the harness runs — the server/sandbox filesystem, not your
machine. With `local` and `cloud-oauth` they run on your machine. The editor fs tools (`read_editor_buffer`, `write_via_editor`) always
operate on the editor's files regardless of backend, since they execute in the
adapter and delegate to the ACP client.

## What's implemented

| ACP surface | Status |
|-------------|--------|
| `initialize` (v1 negotiation) | ✅ |
| `session/new` (per-session Letta conversation, cwd) | ✅ |
| `session/prompt` (text, image, resource, resource_link) | ✅ |
| `session/update` — message/thought chunks, tool calls, tool results | ✅ |
| `session/request_permission` (allow once / always / reject) | ✅ |
| `session/cancel` → `stopReason: cancelled` | ✅ |
| `session/load` (resume threads with history replay) | ✅ |
| `session/list` (project-scoped persisted session discovery) | ✅ |
| Session modes (`session/set_mode`: standard / acceptEdits / unrestricted) | ✅ |
| Model listing and switching (`configOptions` + `session/set_config_option`) | ✅ |
| Separate reasoning effort (`configOptions`, category `thought_level`) | ✅ when catalog tiers and effective settings are known |
| Slash commands (`available_commands_update`, ~30 commands + skills) | ✅ |
| Client fs delegation (`fs/read_text_file`, `fs/write_text_file`) | ✅ via external tools |
| MCP servers from `session/new` / `session/load` | ✅ stdio, HTTP, and SSE via Agent SDK external tools |
| Native Bash result rendering (`_meta.terminal_output`) | ✅ when supported by the client |
| Client-side command execution (`terminal/*`) | ❌ (planned) |
| Plan updates (`plan` from TodoWrite) | ❌ (planned) |

ACP session ids are Letta conversation ids, so `session/load` works across
adapter restarts when the client already knows the id: the conversation is
resumed via the SDK and its recent history (up to 200 messages) is replayed as
`session/update` notifications. For discovery, the adapter records the working
directory of successful `session/new` and `session/load` calls under
`~/.letta/letta-acp/sessions/`. `session/list` combines those project-scoped
records with live conversation titles and timestamps from the configured Letta
agent; unrelated conversations are not assigned an inferred project. Session
modes are enforced in the adapter's permission
callback — the harness always runs in `standard` mode so every approval routes
through the adapter, which is what makes live mode switching possible. Session
bookkeeping tools (`TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, and
`TodoWrite`) never require approval; `acceptEdits` additionally auto-allows
file-edit tools, and `unrestricted` auto-allows everything. `/model` (empty to
list, or a handle/preset id to switch) is handled in the adapter without an LLM
turn. Its listing includes preset ids, handles, and advertised efforts/windows.

### Reasoning effort

ACP clients that render `configOptions` with category `thought_level` can show
**Reasoning effort** separately from **Model**. The option id is
`reasoning_effort`; its choices come from the running Letta model catalog, not
from a hard-coded assumption that every model supports every effort level.
Client support and placement depend on the client version.

Catalog-tier changes use the Agent SDK's `session.updateModel` and are persisted by Letta:
named conversations receive a conversation override; the default conversation
updates the agent default. New and loaded sessions read the persisted scoped
settings. Model changes, including `/model`, refresh the configuration snapshot.
Model and effort mutations are serialized per session. A prompt waits for changes
already requested; new model/effort changes are rejected while that prompt is
active. Permission modes can still change live and affect subsequent approval
decisions. Failed updates do not block later requests. The session reuses its model
catalog so a second catalog lookup cannot falsely fail an already applied update.
Effective context windows are read from persisted runtime state, not assumed
from preset metadata; unavailable state is left unknown.
The model menu groups presets by exact provider/model handle, keeping different
providers and BYOK routes separate. Its values are handles, independent of effort
and context-window presets. Labels use a plain catalog label when available,
otherwise the provider-qualified handle rather than an effort-suffixed label.
Reselecting the active model leaves its effort and context unchanged.

Switching models preserves the current effort when the target catalog supports
it; otherwise it follows Letta's catalog order (preferring `medium` when available).
The target model chooses its own context size rather than requiring a match to
the previous model. Use an explicit preset id from `/model` when a particular
effort/window variant is needed. The full raw catalog remains the source for
the separate reasoning menu.
Explicit `LETTA_ACP_MODEL` overrides still apply when opening a session.

The selector is omitted when the effective effort is not explicitly reported,
the model has no supported catalog tiers, or multiple context-window
variants cannot be disambiguated. In particular, an upstream provider default
is not presented as an invented `medium` or `none` setting. Supported catalog tiers
are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, but only the
subset present for the active model is offered. Updates use exact preset IDs,
not the SDK's narrower effort argument. Older Anthropic `xhigh` presets that
Letta persists as `max` are shown as `max`; models with distinct tiers retain both.
Anthropic disabled thinking is explicitly `none`, not an unknown/default tier.
An unmatched custom context window remains usable when the catalog has only one
window family; multiple possible families are omitted rather than guessed.
Custom/BYOK handles need matching catalog entries or a runtime-reported provider
alias. Failed state lookups are logged to stderr and leave reasoning unavailable.
No separate adapter-local reasoning preference is stored.
If a new `letta/auto` session has no selector, use `/model` to choose an explicit
reasoning-tier preset. Once Letta reports that preset's effective settings,
the separate selector appears. An arbitrary model handle without an explicit
reported tier is not guaranteed to enable it.

#### Requested effort for explicitly marked proxy routes

When the exact active route is explicitly marked by Letta with
`updateArgs.openai_compatible_proxy: true` and `provider_type: "openai"`, but
has fewer than two distinct catalog effort tiers, the adapter can instead show
**Requested reasoning effort** (`requested_reasoning_effort`). These are generic
override requests, **not a claim that the upstream model supports each level**.
Choices are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and
**Default (reset override)**. Default sends JSON `null`; it is not `none`.
An explicit persisted `reasoning: null` is displayed as Default. Missing effort
is displayed as **Unknown (not reported)**, never invented as Default or Medium.
Unknown is informational and cannot be submitted as an override.

This uses the public SDK `session.sendCommand` request/response transport, with
an `update_model` payload containing the **exact advertised** `model_id`,
the **exact** `model_handle` from that same context-checked catalog entry, and
`reasoning_effort`. Nested routes such as `litellm/xai/grok-4.7` and
`lc-openrouter/x-ai/grok-4.7` are not stripped or replaced by direct-provider
presets. Responses must confirm success, the same runtime and route, and the
persisted requested effort. Errors are sanitized and release the mutation queue.
The same prompt/mutation protections and persisted-state reload apply.
If an update persists but its acknowledgement is malformed, normalized to another
effort, or times out, the adapter reloads persisted state and attempts a
`config_option_update` notification before returning a sanitized error. This is
not transactional: a timeout does not cancel a backend write, and a write arriving
after the reload cannot be guaranteed to appear in that notification. Reload the
session to reconcile later writes; unavailable state is never invented.

**Runtime limitation:** Letta Code's `list_models` can decorate proxy metadata
that is absent from its underlying `models2` catalog. A handle-only update takes
that undecorated catalog entry and can silently drop the effort. Sending the
advertised ID plus handle can merge native inventory metadata, but only when
that inventory actually supplies the provider metadata needed for proxy updates.
The true local Letta Code harness's `listLocalModels` does not supply
`provider_category`/`model_endpoint`, so ID plus handle does **not** make it
supported: an update can drop the effort while changing other settings.
The adapter therefore hides and rejects this raw override for local SDK
transport unless `appServer.harnessBackend` is `"api"`. This leaves
`cloud-oauth` (local transport with an API harness), remote, and cloud eligible;
catalog-backed effort controls are unaffected.
On cloud routes where the preset ID equals the handle, the resolver
can still skip that merge and drop the effort if the underlying preset lacks
the proxy flag. The adapter does not borrow another provider's preset to work
around this and reports failure when the acknowledgement does not confirm the
requested effort. Neither the advertised menu nor persistence confirms upstream
support for the requested tier.

The public command has no context-window override. To avoid silently changing
context, this fallback requires a known positive current context and either no
catalog context window or one exactly matching the current window. An unmatched
128000 window is excluded because Letta treats it as a legacy clamp rather than
a preservable custom window. Failed state lookups hide the override until context
can be confirmed. Unmarked routes, conflicting context metadata, and routes with
adequate catalog tiers do not receive this generic fallback.

**How Letta Code does it (installed 0.34.14 source):**

- In `node_modules/@letta-ai/letta-code/letta.js`,
  `getByokOpenAIReasoningTierOptions`: reported capabilities first, otherwise
  registry tiers, otherwise the generic effort list; prepend `null` for Default.
- The model picker checks explicit proxy metadata,
  builds effort selections, and opens the reasoning prompt.
  It calls `updateAgentLLMConfig` or
  `updateConversationLLMConfig` with the chosen effort.
- `buildModelSettings`: OpenAI proxy settings encode reset as `reasoning: null`,
  otherwise as `reasoning: { reasoning_effort: ... }`.
- `buildListModelsResponse` decorates proxy entries; `resolveModelForUpdateBase`
  resolves IDs before handles and merges `availableModelUpdateArgs` where
  permitted. `resolveModelForUpdate` overlays string efforts (including `max`)
  or `null` only when resolved metadata permits them.
- SDK 0.8.44 `src/types.ts` publicly exposes protocol messages,
  `SendCommandOptions`, and `sendCommand`. `src/remote-client-session-core.ts`
  forwards waitable commands; `AppServerSessionController.request` in
  `src/app-server-session.ts` supplies a request ID. The Letta Code control
  transport correlates replies and enforces timeout/disconnect behavior. Raw replies require caller
  success validation. In contrast, SDK `updateModel({ reasoningEffort })` selects
  existing presets; it cannot express this raw override or reset.

### Slash commands

The adapter advertises the [Letta slash commands](https://docs.letta.com/platform/cli/slash-commands)
that make sense over ACP, so they appear in the client's `/` menu:

- **Adapter-native**: `/model`.
- **Harness-executed** (via the app-server `execute_command` protocol):
  `/clear`, `/compact`, `/init`, `/doctor`, `/remember`, `/context-limit`,
  `/reload`, `/toolset`. Commands that run a full agent turn (`/init`,
  `/remember`, `/doctor`) stream their tool calls and output like any prompt.
- **Model-interpreted**: `/memory`, `/search`, `/skills`, `/skill-creator`,
  plus every skill discovered on disk (bundled with letta-code,
  `~/.letta/skills`, and the session cwd's `.claude/skills`) — these forward
  as prompt text, which the harness instructs the model to treat as a skill
  invocation.

The rest of the CLI's commands (`/agents`, `/resume`, `/login`, `/statusline`,
`/exit`, …) are TUI dialogs or local-process controls with no protocol
equivalent; use the editor's own UI for those (new thread ≈ `/new`, thread
history ≈ `/resume`).

## Saved-login live smoke (Node)

For this landing, the approved live-check substitution is the saved-login
`cloud-oauth` smoke below, rather than the API-key local/cloud live checks.
It is not evidence that either API-key backend was exercised.

```sh
npm run build
npm run test:backend:live:cloud-oauth
```

Run on the machine with the existing Letta login, not in an isolated agent clone.
Both the smoke and built adapter use Node (the SDK also launches its harness
with that Node executable), never Bun. No new login or provider-setting changes
are performed. The harness discovers/refreshes saved OAuth itself; the script
does not read credentials and suppresses raw errors and subprocess output.
It removes `LETTA_API_KEY` and `LETTA_AGENT_ID` from its own process environment,
preserves HOME/keychain discovery, and uses a temporary cwd and ACP state directory.

The default route is `chatgpt-plus-pro/gpt-6-luna-fast`; set
`LETTA_ACP_SMOKE_MODEL` to another exact account-supported handle if necessary.
The smoke first requires catalog membership and confirmed account availability,
then checks ACP initialization, a new dedicated agent/session, current model
configuration, `/model`, and one exact sentinel response without tool calls.
This sends one small model request and can consume subscription quota or incur
cost. Tool approvals are denied; the temporary cwd is not an OS sandbox.

Cleanup deletes only the agent acknowledged as newly created by this adapter,
using SDK local management with the API harness, and closes owned processes.
Stage deadlines and cleanup failures return a nonzero exit status. A server
creation that succeeds without delivering its ID, forced termination, or failed
deletion can leave a temporary agent behind; the script reports this rather
than guessing ownership or deleting existing agents. Saved-login refresh and
ordinary harness caches may still be updated.

## How it works

`src/agent.ts` maps the two protocols:

- Each ACP session becomes a new conversation (`client.createSession`) on one
  underlying Letta agent, with the ACP `cwd`.
- `session/prompt` sends the message and pumps `session.stream()`, translating
  SDK messages (`assistant`, `reasoning`, `tool_call`, `tool_result`) into
  `session/update` notifications.
- When the client advertises `_meta.terminal_output`, Bash calls use ACP terminal
  content plus `terminal_info`, `terminal_output`, and `terminal_exit` updates.
  Zed controls whether terminal cards start expanded or collapsed; the adapter
  sends the complete output and retains it in `rawOutput`.
- Tool approvals: the SDK's `canUseTool` callback is forwarded as an ACP
  `session/request_permission` request. One Letta-specific wrinkle: the
  app-server transport ends the turn with a recoverable `approval_conflict`
  result while the approval is pending, and the resumed run streams without a
  second terminal result — so after such a result the adapter keeps pumping
  the stream (approvals resolve concurrently over the control channel) and
  ends the turn when the agent loop reports it is idle again.

## Editor file access (external tools)

The harness's built-in tools (`Read`, `Edit`, `Bash`, …) always execute
Letta-side, directly against the filesystem — the ACP client only *renders*
those tool calls. Letta's [external tools](https://docs.letta.com/platform/app-server/external-tools)
add capabilities on top (they cannot replace built-ins), and the adapter uses
them to close the editor-integration gap: when the client advertises
`clientCapabilities.fs` during `initialize`, each session registers:

- **`read_editor_buffer`** → proxies ACP `fs/read_text_file`, so the agent can
  read files *as the editor sees them*, including unsaved buffer changes that
  disk-based `Read` would miss.
- **`write_via_editor`** → proxies ACP `fs/write_text_file`, so a write lands
  in the editor's buffer with diff review and undo history instead of a raw
  disk write.

The tool descriptions steer the model to prefer these for files the user has
open and the built-ins otherwise. Both go through the normal permission flow.
Clients that don't advertise fs capabilities get no extra tools and everything
runs Letta-side as before. Terminal delegation (`terminal/*`) is the remaining
piece.

## MCP servers

ACP clients can pass stdio, Streamable HTTP, and SSE MCP servers in
`session/new` and `session/load`. The adapter maps the ACP transport shape to
`@letta-ai/letta-agent-sdk`, which owns connections, tool discovery,
`mcp__<server>__<tool>` namespacing, execution, failure isolation, and cleanup
for the session. The adapter advertises HTTP and SSE MCP capabilities; ACP's
experimental in-band MCP transport is not supported.
