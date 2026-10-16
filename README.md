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

### Tests

```bash
bun run check       # tests (including the acpx suite), typecheck, build
bun run test:acpx   # acpx CLI -> adapter stdio -> fake Letta app server
```

The acpx suite uses the published `acpx` CLI and this adapter's real stdio
entrypoint to verify a complete tool-call lifecycle without credentials or an
LLM; it runs on every pull request. Trusted pushes to `main` also run the live
`test:backend:live:local` and `test:backend:live:cloud` checks with dedicated
credentials. Live scripts, including the saved-login `cloud-oauth` smoke, are
described in [docs/model-controls.md](docs/model-controls.md#live-checks).

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
| Separate reasoning effort and context size (`configOptions`) | ✅ from Letta's presets ([details](#model-reasoning-effort-and-context-size)) |
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
turn.

### Model, reasoning effort, and context size

Clients that render ACP `configOptions` get up to three selectors. Their choices
come from the running Letta model catalog (the proxy override below is the one
generic exception); there is no free-form context size and no adapter-invented
combination.

- **Model** (`model`): one entry per exact provider/model route (BYOK and
  provider-qualified routes stay separate). Values are route handles; names are
  catalog labels, `Model: <handle>` when the catalog has no usable label, and
  `<handle> (current)` for an active route the catalog does not list. Switching
  models keeps the current effort when the target offers it.
- **Context size** (`context_window`, category `model_config`) and **Reasoning
  effort** (`reasoning_effort`, category `thought_level`): the windows and tiers
  Letta's presets offer for the route, listed context first. Changing context
  keeps the tier. Changing effort keeps the window when Letta has that pair;
  from a window outside the presets it moves to that tier's first preset window,
  and the selectors show the result.
- **Reasoning & context** (`letta_preset`): replaces the two selectors on the few
  routes whose presets don't cover every tier at every window (for example Opus
  5 offers 950K only at `high`), listing only real presets.

Persisted state outside the presets (such as a 1,050,000-token window where the
presets are 350K and 950K, as observed on a newly created Luna agent) or an
unreported tier is shown as the current value and marked as such; it is never
resized on discovery and cannot be reselected once left. Changes are persisted
by Letta (a conversation override, or the agent default for the default
conversation), serialized per session, and rejected while a prompt runs. After
each prompt the adapter re-reads persisted state and notifies the client if it
changed. An effort change that also needs a window correction is two writes and
not transactional: on failure the client receives the actual persisted state
with the error.

Explicitly marked OpenAI-compatible proxy routes with at most one catalog tier
get **Requested reasoning effort** (`requested_reasoning_effort`) instead:
generic override requests (`none` … `max`, plus **Default**, which resets to
the provider default and is not `none`). These are not a claim that the
upstream model supports each level, and they are unavailable on the true
`local` harness. `/model` lists every preset id, handle, and advertised
effort/window, and `/model <preset-id>` applies an exact preset.

Client support (adapter 0.1.x; details and evidence in
[docs/model-controls.md](docs/model-controls.md)):

| Client | Model | Effort / context |
|---|---|---|
| Zed | ✅ | ✅ |
| T3 Code (Nightly 0.0.46) | ✅ | ✅ — restart T3 after upgrading the adapter so it re-probes; it shows one probe's options for every model until a session reports its own |
| JetBrains DataGrip 2026.2 with the Air plugin | ✅ | ✅ |
| JetBrains Air (standalone) | ✅ | ❌ no generic effort/context controls rendered |

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
