import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";

// No credential files are read here. Keep HOME/keychain discovery intact; the
// harness resolves and refreshes the existing login. Never print raw SDK errors,
// protocol payloads, environment values, or subprocess output.
if (process.versions.bun) {
  console.error("Run this smoke test with Node, not Bun.");
  process.exit(1);
}
delete process.env.LETTA_AGENT_ID;
delete process.env.LETTA_API_KEY;
const model = process.env.LETTA_ACP_SMOKE_MODEL ?? "chatgpt-plus-pro/gpt-6-luna-fast";
const marker = "ACP_CLOUD_OAUTH_OK";
const workspace = mkdtempSync(join(tmpdir(), "letta-acp-oauth-live-"));
const originalCwd = process.cwd();
process.chdir(workspace);
const client = new LettaAgentClient({
  backend: "local",
  appServer: {
    harnessBackend: "api",
    pinGlobalAgent: false,
    requestTimeoutMs: 30_000,
    startupTimeoutMs: 30_000,
  },
});
let child;
let childClosed;
let ownedAgentId;
let stage = "model availability";
let failed = false;
let cleanupFailed = false;
let creationStarted = false;
let stderrRemainder = "";
let text = "";
let usedTools = false;

function check(condition) {
  if (!condition) throw new Error("Smoke assertion failed");
}

async function deadline(operation, ms = 60_000) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Smoke deadline exceeded")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Only an adapter creation acknowledgement can establish ownership. Never
// resolve arbitrary session IDs or list/delete existing account agents.
function collectStderr(chunk) {
  stderrRemainder += chunk.toString();
  const lines = stderrRemainder.split(/\r?\n/);
  stderrRemainder = lines.pop().slice(-4096);
  for (const line of lines) {
    const match = line.match(/created agent (agent-[0-9a-f-]{36}) — set LETTA_AGENT_ID=\1 to keep using it/);
    if (creationStarted && match) ownedAgentId ??= match[1];
  }
}

try {
  const catalog = await deadline(client.models.list());
  check(catalog.entries.some((entry) => entry.handle === model));
  // Fail closed if account availability is unknown or excludes this route.
  check(catalog.availableHandles?.includes(model));
  stage = "adapter startup";
  child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
    cwd: workspace,
    env: {
      ...process.env,
      LETTA_ACP_BACKEND: "cloud-oauth",
      LETTA_ACP_MODEL: model,
      LETTA_ACP_PERMISSION_MODE: "standard",
      LETTA_ACP_STATE_DIR: join(workspace, "sessions"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  childClosed = new Promise((resolve) => child.once("close", resolve));
  // Swallow raw errors; protocol operations fail with a sanitized stage below.
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  child.stderr.on("data", collectStderr);
  const connection = new ClientSideConnection(() => ({
    requestPermission() {
      usedTools = true;
      return { outcome: { outcome: "cancelled" } };
    },
    sessionUpdate({ update }) {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        text += update.content.text;
      }
      if (update.sessionUpdate === "tool_call") usedTools = true;
    },
  }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  stage = "ACP initialize";
  const initialized = await deadline(connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "letta-acp-oauth-smoke", version: "1" },
  }), 30_000);
  check(initialized.protocolVersion === PROTOCOL_VERSION);
  stage = "ACP session/new";
  creationStarted = true;
  const session = await deadline(connection.newSession({ cwd: workspace, mcpServers: [] }), 120_000);
  check(session.sessionId.startsWith("conv-"));
  const option = session.configOptions?.find((item) => item.id === "model");
  check(option?.type === "select" && option.currentValue === model);
  check(option.options.some((item) => item.value === model));
  stage = "ACP model listing";
  await deadline(connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "/model" }],
  }));
  check(text.includes("Available models:") && text.includes(model));
  text = "";
  stage = "ACP sentinel response";
  const result = await deadline(connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: `Reply with exactly ${marker} and nothing else. Do not use tools.` }],
  }), 180_000);
  check(result.stopReason === "end_turn" && text.trim() === marker && !usedTools);
} catch {
  failed = true;
  console.error(`Cloud OAuth smoke failed at ${stage}; raw diagnostics suppressed to protect credentials.`);
} finally {
  if (child) {
    child.stdin.end();
    try {
      await deadline(childClosed, 10_000);
    } catch {
      child.kill("SIGKILL");
      try { await deadline(childClosed, 5_000); } catch {
        cleanupFailed = true;
        console.error("Adapter process did not close after forced shutdown.");
      }
    }
    collectStderr("\n");
  }
  if (ownedAgentId) {
    try {
      // cloud-oauth management is local app-server transport + API harness,
      // NOT the API-key-only `backend: "cloud"` management client.
      await deadline(client.agents.delete(ownedAgentId), 45_000);
    } catch {
      cleanupFailed = true;
      console.error(`Temporary agent cleanup failed; manually remove only ${ownedAgentId}.`);
    }
  } else if (creationStarted) {
    cleanupFailed = true;
    console.error("Creation was attempted without an acknowledged agent ID. A temporary agent may remain; no existing agents were deleted.");
  }
  try { await deadline(client.close(), 10_000); } catch {
    cleanupFailed = true;
    console.error("OAuth management client did not close cleanly.");
  }
  process.chdir(originalCwd);
  // Windows can retain subprocess/file handles briefly after SDK close.
  try {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    cleanupFailed = true;
    console.error("Temporary smoke workspace could not be removed.");
  }
}
if (cleanupFailed) console.error("Cloud OAuth smoke cleanup was incomplete.");
if (!failed && !cleanupFailed) {
  console.log("Cloud OAuth smoke passed: initialize, dedicated session, model availability/current config/listing, exact sentinel, and agent cleanup.");
}
// Bound leftover SDK sockets after close/deadlines; never hang a landing check.
process.exit(failed || cleanupFailed ? 1 : 0);
