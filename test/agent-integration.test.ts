import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContext, McpServer } from "@agentclientprotocol/sdk";
import type { LettaCodeSession, LettaCodeSocketConstructor } from "@letta-ai/letta-agent-sdk";
import { LettaAcpAgent, toSdkMcpServers } from "../src/agent.js";
import { configFromEnv, type LettaAcpConfig } from "../src/config.js";
import { SessionRegistry } from "../src/session-registry.js";

interface RuntimeScope {
  agent_id: string;
  conversation_id: string;
}

type WireMessage = Record<string, unknown>;
type SocketListener = (event: unknown) => void;

interface ServerSocket {
  readonly channel: "control" | "stream";
  push(message: WireMessage): void;
}

class FakeAppServer {
  readonly runtimeStartRequestIds: string[] = [];
  readonly createdAgentBodies: WireMessage[] = [];
  readonly createdAgentPinGlobals: unknown[] = [];
  readonly approvalResponses: WireMessage[] = [];
  readonly conversationRetrieveIds: string[] = [];
  closedSockets = 0;
  readonly updatedModelPayloads: WireMessage[] = [];
  readonly inputModels: string[] = [];
  reasoningModel = false;
  anthropicReasoning = false;
  legacyXhigh = true;
  updateResponseSettings: WireMessage | undefined;
  modelSettings: WireMessage = {};
  modelHandle = "test/model";
  rejectModelUpdate = false;
  rejectCatalog = false;
  catalogRequests = 0;
  alternateReasoning = false;
  alternateWindows = false;
  contextWindow: number | undefined;
  proxyRoute: string | undefined;
  proxyMarked = true;
  proxyPresetId: string | undefined;
  proxyCloud = false;
  persistedProxyResponse: WireMessage | "timeout" | undefined;
  normalizedProxyEffort: string | undefined;
  proxyCatalogWindow: number | undefined;
  unrelatedProxyReply = false;
  rejectModelState = false;
  malformedProxyResponse: WireMessage | undefined;
  /** Realistic Letta grid: one route, 350K/950K presets x six efforts. */
  lunaCatalog = false;
  /** Make the 950K presets differ beyond context_window. */
  lunaDivergent = false;
  /** Letta's live sparse shape: Opus 5 offers 950K only at high. */
  opusCatalog = false;
  /** Runtime preservation heuristic: a preset update keeps the old window. */
  preserveWindow = false;
  defaultConversation = false;
  agentModel = "test/model";
  agentSettings: WireMessage = {};
  agentContextWindow: number | undefined;
  readonly contextUpdates: Array<{ scope: "agent" | "conversation"; body: WireMessage }> = [];
  rejectContextUpdate = false;
  ignoreContextUpdate = false;
  private pausedUpdate: ((resume: () => void) => void) | undefined;
  private pausedRetrieve: ((resume: () => void) => void) | undefined;

  pauseNextAgentRetrieve() {
    let release!: () => void;
    let started!: () => void;
    const received = new Promise<void>((resolve) => { started = resolve; });
    this.pausedRetrieve = (resume) => {
      release = resume;
      started();
    };
    return { received, release: () => release() };
  }

  pauseNextModelUpdate() {
    let release!: () => void;
    let started!: () => void;
    const received = new Promise<void>((resolve) => { started = resolve; });
    this.pausedUpdate = (resume) => {
      release = resume;
      started();
    };
    return { received, release: () => release() };
  }

  private nextConversation = 0;
  private activeControlSocket: ServerSocket | null = null;
  private activeRuntime: RuntimeScope | null = null;
  private activeCommand: string | null = null;
  private approvalWaiters: Array<(payload: WireMessage) => void> = [];
  private commandWaiters: Array<() => void> = [];
  private cancelablePromptWaiters: Array<() => void> = [];
  private cancelablePromptActive = false;

  socketConstructor(): LettaCodeSocketConstructor {
    const server = this;

    class FakeSocket {
      readyState = 0;
      readonly channel: "control" | "stream";
      private readonly listeners = new Map<string, Set<SocketListener>>();

      constructor(url: string) {
        this.channel = new URL(url).searchParams.get("channel") === "stream"
          ? "stream"
          : "control";
        queueMicrotask(() => {
          this.readyState = 1;
          this.emit("open", {});
        });
      }

      send(data: string): void {
        server.receive(this, JSON.parse(data) as WireMessage);
      }

      close(): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        server.closedSockets += 1;
        this.emit("close", {});
      }

      addEventListener(type: string, listener: SocketListener): void {
        const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: SocketListener): void {
        this.listeners.get(type)?.delete(listener);
      }

      push(message: WireMessage): void {
        queueMicrotask(() => {
          this.emit("message", { data: JSON.stringify(message) });
        });
      }

      private emit(type: string, event: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }
    }

    return FakeSocket as unknown as LettaCodeSocketConstructor;
  }

  /** Resolves with the next approval_response the adapter sends back. */
  nextApprovalResponse(): Promise<WireMessage> {
    return new Promise((resolve) => {
      this.approvalWaiters.push(resolve);
    });
  }

  /** Resolves when the adapter dispatches its next execute_command. */
  nextCommand(): Promise<void> {
    return new Promise((resolve) => {
      this.commandWaiters.push(resolve);
    });
  }

  /** Resolves after a prompt has produced activity but before it completes. */
  nextCancelablePrompt(): Promise<void> {
    return new Promise((resolve) => {
      this.cancelablePromptWaiters.push(resolve);
    });
  }

  requestPermissionAfterPrompt(
    overrides: {
      requestId?: string;
      toolName?: string;
      toolCallId?: string;
      input?: Record<string, unknown>;
    } = {},
  ): void {
    const socket = this.activeControlSocket;
    const runtime = this.activeRuntime;
    if (!socket || !runtime) {
      throw new Error("No active runtime for late permission request");
    }
    socket.push({
      type: "control_request",
      request_id: overrides.requestId ?? "approval-request-after-prompt",
      runtime,
      request: {
        subtype: "can_use_tool",
        tool_name: overrides.toolName ?? "Bash",
        tool_call_id: overrides.toolCallId ?? "call-after-prompt",
        input: overrides.input ?? {
          command: "pwd",
          description: "Show working directory after prompt",
        },
      },
    });
  }

  private receive(socket: ServerSocket, message: WireMessage): void {
    if (socket.channel !== "control") {
      throw new Error(`Unexpected command on ${socket.channel} channel`);
    }
    if (message.type === "agent_retrieve" && this.pausedRetrieve) {
      const pause = this.pausedRetrieve;
      this.pausedRetrieve = undefined;
      pause(() => this.receive(socket, message));
      return;
    }
    if ((message.type === "update_model" || message.type === "conversation_update") && this.pausedUpdate) {
      const pause = this.pausedUpdate;
      this.pausedUpdate = undefined;
      pause(() => this.receive(socket, message));
      return;
    }

    switch (message.type) {
      case "runtime_start": {
        const requestId = requiredString(message.request_id, "runtime_start.request_id");
        const conversationId = this.defaultConversation ? "default" : `conv-test-${++this.nextConversation}`;
        const createAgent = message.create_agent as
          | { body?: WireMessage; pin_global?: boolean }
          | undefined;
        const agentId =
          typeof message.agent_id === "string"
            ? message.agent_id
            : createAgent
              ? "agent-created"
              : "agent-test";
        const runtime = {
          agent_id: agentId,
          conversation_id: conversationId,
        };
        this.runtimeStartRequestIds.push(requestId);
        if (createAgent?.body) {
          this.createdAgentBodies.push(createAgent.body);
          this.createdAgentPinGlobals.push(createAgent.pin_global);
        }
        socket.push({
          type: "runtime_start_response",
          request_id: requestId,
          success: true,
          runtime,
          agent: { id: agentId, model: "test/model", tools: [] },
          conversation: { id: conversationId, agent_id: agentId },
        });
        return;
      }
      case "enable_memfs":
        socket.push({
          type: "enable_memfs_response",
          request_id: requiredString(message.request_id, "enable_memfs.request_id"),
          success: true,
          memory_directory: "/tmp/letta-acp-memory",
        });
        return;
      case "agent_retrieve":
        socket.push({
          type: "agent_retrieve_response",
          request_id: message.request_id,
          success: true,
          agent: {
            id: "agent-test", model: this.agentModel, model_settings: this.agentSettings,
            context_window_limit: this.agentContextWindow,
          },
        });
        return;
      case "agent_update":
      case "conversation_update": {
        const scope = message.type === "agent_update" ? "agent" : "conversation";
        const body = message.body as WireMessage;
        this.contextUpdates.push({ scope, body });
        if (this.rejectContextUpdate) {
          socket.push({
            type: `${message.type}_response`, request_id: message.request_id,
            success: false, error: "secret backend credential",
          });
          return;
        }
        if (typeof body.context_window_limit === "number" && !this.ignoreContextUpdate) {
          if (scope === "agent") this.agentContextWindow = body.context_window_limit;
          else this.contextWindow = body.context_window_limit;
        }
        socket.push({
          type: `${message.type}_response`, request_id: message.request_id, success: true,
          ...(scope === "agent"
            ? { agent: { id: "agent-test", model: this.agentModel, context_window_limit: this.agentContextWindow } }
            : { conversation: { id: message.conversation_id, agent_id: "agent-test", context_window_limit: this.contextWindow } }),
        });
        return;
      }
      case "conversation_retrieve": {
        const conversationId = requiredString(
          message.conversation_id,
          "conversation_retrieve.conversation_id",
        );
        this.conversationRetrieveIds.push(conversationId);
        if (conversationId.includes("missing") || this.rejectModelState) {
          socket.push({
            type: "conversation_retrieve_response",
            request_id: requiredString(
              message.request_id,
              "conversation_retrieve.request_id",
            ),
            success: false,
            error: "conversation unavailable",
          });
          return;
        }
        socket.push({
          type: "conversation_retrieve_response",
          request_id: requiredString(
            message.request_id,
            "conversation_retrieve.request_id",
          ),
          success: true,
          conversation: {
            id: conversationId,
            agent_id: conversationId.includes("foreign") ? "agent-other" : "agent-test",
            archived: conversationId.includes("archived"),
            model: this.modelHandle,
            model_settings: this.modelSettings,
            context_window_limit: this.contextWindow,
          },
        });
        return;
      }
      case "conversation_messages_list":
        socket.push({
          type: "conversation_messages_list_response",
          request_id: requiredString(
            message.request_id,
            "conversation_messages_list.request_id",
          ),
          success: true,
          messages: [],
          has_more: false,
        });
        return;
      case "list_models":
        this.catalogRequests += 1;
        if (this.rejectCatalog) {
          socket.push({
            type: "list_models_response",
            request_id: message.request_id,
            success: false,
            error: "catalog unavailable",
          });
          return;
        }
        socket.push({
          type: "list_models_response",
          request_id: requiredString(message.request_id, "list_models.request_id"),
          success: true,
          entries: [
            ...(this.proxyRoute ? [{
              id: this.proxyPresetId ?? this.proxyRoute,
              handle: this.proxyRoute,
              label: "Proxy model",
              description: "",
              updateArgs: {
                provider_type: "openai",
                openai_compatible_proxy: this.proxyMarked,
                context_window: this.proxyCatalogWindow,
              },
            }] : []),
            {
              id: "test-model",
              handle: "test/model",
              label: "Test Model",
              description: "Deterministic test model",
              isDefault: true,
            },
            {
              id: "other-model",
              handle: "test/other-model",
              label: "Other Model",
              description: "Alternate deterministic model",
            },
            ...(this.reasoningModel ? (this.anthropicReasoning ? ["none", "high", ...(this.legacyXhigh ? ["xhigh"] : []), "max"] : ["low", "high"]).map((effort) => ({
              id: `test-${effort}`,
              handle: "test/model",
              label: `Test ${effort}`,
              description: "",
              updateArgs: {
                reasoning_effort: effort,
                ...(this.anthropicReasoning ? { provider_type: "anthropic", ...(effort === "none" ? { enable_reasoner: false } : {}) } : {}),
              },
            })) : []),
            ...(this.alternateReasoning ? ["low", "high"].map((effort) => ({
              id: `other-${effort}`,
              handle: "test/other-model",
              label: `Other ${effort}`,
              description: "",
              updateArgs: { reasoning_effort: effort, context_window: 100_000 },
            })) : []),
            ...(this.lunaCatalog ? [350_000, 950_000].flatMap((window) =>
              ["none", "low", "medium", "high", "xhigh", "max"].map((effort) => ({
                id: `luna${window === 950_000 ? "-1m" : ""}-${effort}`,
                handle: "chatgpt-plus-pro/gpt-6-luna",
                label: window === 950_000 ? "GPT-6 Luna 1M" : "GPT-6 Luna",
                description: "",
                updateArgs: {
                  reasoning_effort: effort,
                  verbosity: this.lunaDivergent && window === 950_000 ? "medium" : "low",
                  parallel_tool_calls: true, context_window: window, max_output_tokens: 128_000,
                },
              }))) : []),
            ...(this.opusCatalog ? [
              ...["low", "medium", "high", "xhigh", "max"].map((effort) => ({ id: `opus-5-${effort}`, effort, window: 200_000 })),
              { id: "opus-5-1m", effort: "high", window: 950_000 },
            ].map(({ id, effort, window }) => ({
              id, handle: "anthropic/claude-opus-5", label: window > 200_000 ? "Opus 5 1M" : "Opus 5", description: "",
              updateArgs: {
                provider_type: "anthropic", reasoning_effort: effort, enable_reasoner: true,
                context_window: window, max_output_tokens: 128_000,
              },
            })) : []),
            ...(this.alternateWindows ? [{
              id: "other-high-large",
              handle: "test/other-model",
              label: "Other high large",
              description: "",
              updateArgs: { reasoning_effort: "high", context_window: 200_000 },
            }] : []),
          ],
          available_handles: ["test/model", "test/other-model"],
        });
        return;
      case "update_model": {
        const payload = message.payload as WireMessage;
        this.updatedModelPayloads.push(payload);
        if (this.unrelatedProxyReply) {
          socket.push({
            type: "update_model_response",
            request_id: "unrelated-request",
            success: false,
            error: "must not settle the active request",
          });
        }
        if (this.malformedProxyResponse) {
          socket.push({
            type: "update_model_response",
            request_id: message.request_id,
            ...this.malformedProxyResponse,
          });
          return;
        }
        if (this.rejectModelUpdate) {
          socket.push({
            type: "update_model_response",
            request_id: message.request_id,
            success: false,
            error: "model update rejected",
          });
          return;
        }
        const modelHandle =
          typeof payload.model_handle === "string" ? payload.model_handle : undefined;
        const modelId =
          typeof payload.model_id === "string"
            ? payload.model_id
            : modelHandle
              ? modelHandle.split("/").at(-1) ?? modelHandle
              : requiredString(payload.model_id, "update_model.model_id");
        const handle =
          modelHandle ??
          (modelId.startsWith("other-") ? "test/other-model" : "test/model");
        const luna = this.lunaCatalog ? /^luna(-1m)?-(\w+)$/.exec(modelId) : null;
        const opus = this.opusCatalog ? /^opus-5-(\w+)$/.exec(modelId) : null;
        if (opus) {
          this.modelHandle = handle;
          this.modelSettings = { provider_type: "anthropic", effort: opus[1] === "1m" ? "high" : opus[1] };
          if (!this.preserveWindow) this.contextWindow = opus[1] === "1m" ? 950_000 : 200_000;
        } else if (luna && !this.preserveWindow) {
          // A same-window preset leaves the window as is; otherwise it applies its own.
          if (this.defaultConversation) this.agentContextWindow = luna[1] ? 950_000 : 350_000;
          else this.contextWindow = luna[1] ? 950_000 : 350_000;
        }
        if (!opus) this.modelHandle = handle;
        if (!opus) this.modelSettings = luna
          ? { provider_type: "chatgpt_oauth", reasoning: { reasoning_effort: luna[2] } }
          : /^(test|other)-(low|high)$/.test(modelId)
          ? { provider_type: "openai", reasoning: { reasoning_effort: modelId.split("-")[1] } }
          : {};
        if (this.anthropicReasoning) {
          const effort = modelId.split("-")[1];
          this.modelSettings = effort === "none"
            ? { provider_type: "anthropic", thinking: { type: "disabled" } }
            : { provider_type: "anthropic", effort: effort === "xhigh" ? "max" : effort };
        }
        if (this.defaultConversation) {
          this.agentModel = handle;
          this.agentSettings = this.modelSettings;
        }
        // models2 lacks the flag even though list_models decorates its entry.
        // ID resolution merges native inventory locally; handle-only resolution
        // returns models2 unchanged. Cloud id==handle skips that inventory merge.
        const resolvedProxy = this.proxyMarked &&
          payload.model_id === (this.proxyPresetId ?? this.proxyRoute) &&
          payload.model_handle === this.proxyRoute &&
          !(this.proxyCloud && payload.model_id === payload.model_handle);
        if (this.proxyRoute && resolvedProxy && Object.hasOwn(payload, "reasoning_effort")) {
          this.modelSettings = {
            provider_type: "openai",
            reasoning: payload.reasoning_effort === null ? null : {
              reasoning_effort: this.normalizedProxyEffort ?? payload.reasoning_effort,
            },
          };
        }
        if (this.persistedProxyResponse === "timeout") return;
        socket.push({
          type: "update_model_response",
          request_id: requiredString(message.request_id, "update_model.request_id"),
          success: true,
          runtime: message.runtime,
          applied_to: "conversation",
          model_id: modelId,
          model_handle: handle,
          model_settings: this.updateResponseSettings ?? this.modelSettings,
          ...this.persistedProxyResponse,
        });
        return;
      }
      case "input":
        this.inputModels.push(this.modelHandle);
        this.handleInput(socket, message);
        return;
      case "execute_command":
        this.handleCommand(socket, message);
        return;
      case "abort_message":
        socket.push({
          type: "abort_message_response",
          request_id: requiredString(
            message.request_id,
            "abort_message.request_id",
          ),
          success: true,
        });
        if (this.activeCommand || this.cancelablePromptActive) {
          socket.push({
            type: "update_loop_status",
            runtime: this.activeRuntime,
            loop_status: {
              status: "WAITING_ON_INPUT",
              active_run_ids: [],
            },
          });
          this.cancelablePromptActive = false;
        }
        return;
      default:
        throw new Error(`Unhandled fake app-server command: ${String(message.type)}`);
    }
  }

  private handleInput(socket: ServerSocket, message: WireMessage): void {
    const runtime = message.runtime as RuntimeScope;
    const payload = message.payload as Record<string, unknown>;
    this.activeControlSocket = socket;
    this.activeRuntime = runtime;

    if (payload.kind === "approval_response") {
      this.approvalResponses.push(payload);
      for (const waiter of this.approvalWaiters.splice(0)) waiter(payload);
      const command = this.activeCommand;
      this.pushDelta(socket, runtime, {
        message_type: "tool_return_message",
        run_id: command ? "run-command-approval" : "run-approval",
        tool_call_id: command ? "call-command-approval" : "call-approval",
        tool_return: "write completed",
        status: "success",
      });
      this.pushDelta(socket, runtime, {
        message_type: "assistant_message",
        run_id: command ? "run-command-approval" : "run-approval",
        content: command ? "COMMAND_APPROVAL_OK" : "APPROVAL_OK",
      });
      socket.push({
        type: "update_loop_status",
        runtime,
        loop_status: {
          status: "WAITING_ON_INPUT",
          active_run_ids: [],
        },
      });
      if (command) {
        this.pushDelta(socket, runtime, {
          message_type: "slash_command_end",
          command_id: command,
          success: true,
          output: "COMMAND_APPROVAL_OK",
        });
        this.activeCommand = null;
      }
      return;
    }

    if (payload.kind !== "create_message") {
      throw new Error(`Unhandled fake input payload: ${String(payload.kind)}`);
    }

    const promptText = JSON.stringify(payload.messages);
    if (promptText.includes("cancel active prompt")) {
      this.cancelablePromptActive = true;
      for (const waiter of this.cancelablePromptWaiters.splice(0)) waiter();
      this.pushDelta(socket, runtime, {
        message_type: "tool_call_message",
        run_id: "run-cancelled",
        tool_calls: [
          {
            id: "call-cancelled-agent",
            name: "Agent",
            arguments: JSON.stringify({
              description: "Inspect test coverage",
              prompt: "Review the repository tests",
            }),
          },
        ],
      });
      return;
    }
    if (promptText.includes("replacement after cancel")) {
      this.pushDelta(socket, runtime, {
        message_type: "assistant_message",
        run_id: "run-replacement",
        content: "REPLACEMENT_OK",
      });
      this.finishTurn(socket, runtime, "run-replacement", "end_turn");
      return;
    }
    if (promptText.includes("fragmented prompt")) {
      this.streamFragmentedToolCall(socket, runtime);
      return;
    }
    if (promptText.includes("busy idle prompt")) {
      this.reportIdleWhileRunning(socket, runtime, { thenContinue: true });
      return;
    }
    if (promptText.includes("silent idle prompt")) {
      this.reportIdleWhileRunning(socket, runtime, { thenContinue: false });
      return;
    }

    const isApprovalPrompt = promptText.includes("approval prompt");
    if (isApprovalPrompt) {
      this.pushDelta(socket, runtime, {
        message_type: "tool_call_message",
        run_id: "run-approval",
        tool_calls: [
          {
            id: "call-approval",
            name: "Write",
            arguments: JSON.stringify({ file_path: "/tmp/test.txt" }),
          },
        ],
      });
      socket.push({
        type: "control_request",
        request_id: "approval-request-1",
        runtime,
        request: {
          subtype: "can_use_tool",
          tool_name: "Write",
          tool_call_id: "call-approval",
          input: { file_path: "/tmp/test.txt" },
        },
      });
      this.finishTurn(socket, runtime, "run-approval", "requires_approval");
      return;
    }

    if (promptText.includes("edit prompt")) {
      this.pushDelta(socket, runtime, {
        message_type: "tool_call_message",
        run_id: "run-edit",
        tool_calls: [
          {
            id: "call-edit",
            name: "Edit",
            arguments: JSON.stringify({
              file_path: "/tmp/example.ts",
              old_string: "const value = 1;",
              new_string: "const value = 2;",
            }),
          },
        ],
      });
      this.pushDelta(socket, runtime, {
        message_type: "tool_return_message",
        run_id: "run-edit",
        tool_call_id: "call-edit",
        tool_return: JSON.stringify({
          message: "Successfully replaced 1 occurrence",
          replacements: 1,
          startLine: 12,
        }),
        status: "success",
      });
      this.finishTurn(socket, runtime, "run-edit", "end_turn");
      return;
    }

    this.pushDelta(socket, runtime, {
      message_type: "assistant_message",
      run_id: "run-prompt",
      content: "PROMPT_OK",
    });
    this.finishTurn(socket, runtime, "run-prompt", "end_turn");
  }

  private handleCommand(socket: ServerSocket, message: WireMessage): void {
    const runtime = message.runtime as RuntimeScope;
    const command = requiredString(
      message.command_id,
      "execute_command.command_id",
    );
    this.activeControlSocket = socket;
    this.activeRuntime = runtime;
    this.activeCommand = command;
    for (const waiter of this.commandWaiters.splice(0)) waiter();

    this.pushDelta(socket, runtime, {
      message_type: "slash_command_start",
      command_id: command,
    });
    if (command === "init") {
      // Stay silent until the test cancels, reproducing an abort before the
      // command's nested turn emits its first substantive event.
      return;
    }
    this.pushDelta(socket, runtime, {
      message_type: "tool_call_message",
      run_id: "run-command-approval",
      tool_calls: [
        {
          id: "call-command-approval",
          name: "Write",
          arguments: JSON.stringify({ file_path: "/tmp/command-test.txt" }),
        },
      ],
    });
    socket.push({
      type: "control_request",
      request_id: "command-approval-request",
      runtime,
      request: {
        subtype: "can_use_tool",
        tool_name: "Write",
        tool_call_id: "call-command-approval",
        input: { file_path: "/tmp/command-test.txt" },
      },
    });
    this.finishTurn(socket, runtime, "run-command-approval", "requires_approval");
  }

  /**
   * Streams one tool call as the app-server really does: an opening chunk
   * carrying the name plus a slice of the arguments, then continuation chunks
   * that carry argument text only (and therefore no tool name).
   */
  private streamFragmentedToolCall(
    socket: ServerSocket,
    runtime: RuntimeScope,
  ): void {
    const fragments = [
      { name: "Bash", arguments: '{"command":"git status"' },
      { arguments: ',"description":"Show the ' },
      { arguments: 'working tree status"}' },
    ];
    for (const fragment of fragments) {
      this.pushDelta(socket, runtime, {
        message_type: "tool_call_message",
        run_id: "run-fragmented",
        tool_calls: [{ id: "call-fragmented", ...fragment }],
      });
    }
    this.pushDelta(socket, runtime, {
      message_type: "tool_return_message",
      run_id: "run-fragmented",
      tool_call_id: "call-fragmented",
      tool_return: "nothing to commit",
      status: "success",
    });
    this.finishTurn(socket, runtime, "run-fragmented", "end_turn");
  }

  /**
   * Reports WAITING_ON_INPUT while still listing an active run — the shape
   * that makes the SDK synthesize a successful, stop-reason-less result even
   * though the agent is mid-step. `thenContinue` decides whether the run
   * really was still going (after a beat, as a real server would take) or
   * whether the status was simply stale and nothing more arrives.
   */
  private reportIdleWhileRunning(
    socket: ServerSocket,
    runtime: RuntimeScope,
    options: { thenContinue: boolean },
  ): void {
    this.pushDelta(socket, runtime, {
      message_type: "assistant_message",
      run_id: "run-first",
      content: "WORKING",
    });
    socket.push({
      type: "update_loop_status",
      runtime,
      loop_status: {
        status: "WAITING_ON_INPUT",
        active_run_ids: ["run-second"],
      },
    });
    if (!options.thenContinue) return;
    // A real server takes a beat before the next step; without the delay the
    // continuation lands in the same microtask batch and hides the race.
    setTimeout(() => {
      this.pushDelta(socket, runtime, {
        message_type: "assistant_message",
        run_id: "run-second",
        content: "STILL_WORKING",
      });
      // The turn tracker was already consumed by the contradicted result, so
      // the run ends the way post-approval rounds do: on a real idle status.
      socket.push({
        type: "update_loop_status",
        runtime,
        loop_status: { status: "WAITING_ON_INPUT", active_run_ids: [] },
      });
    }, 20);
  }

  private pushDelta(
    socket: ServerSocket,
    runtime: RuntimeScope,
    delta: WireMessage,
  ): void {
    socket.push({ type: "stream_delta", runtime, delta });
  }

  /**
   * Agent SDK 0.8 parks a pending terminal on `stop_reason` and completes the
   * turn only after `turn_finished`. Letta Code has emitted that event since
   * 0.30.28; a fake that stops at `stop_reason` leaves the turn open until
   * `requestTimeoutMs`.
   */
  private finishTurn(
    socket: ServerSocket,
    runtime: RuntimeScope,
    runId: string,
    stopReason: string,
  ): void {
    this.pushDelta(socket, runtime, {
      message_type: "stop_reason",
      run_id: runId,
      stop_reason: stopReason,
    });
    socket.push({
      type: "turn_finished",
      runtime,
      run_id: runId,
      stop_reason: stopReason,
    });
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function createAgent(
  server: FakeAppServer,
  overrides: {
    agentId?: string;
    model?: string;
    sessionRegistryDir?: string | null;
    sessionRegistryScope?: string;
    outOfTurnPermissionTimeoutMs?: number;
    prematureResultGraceMs?: number;
  } = {},
  // The fake server implements API proxy inventory semantics, not listLocalModels.
  clientOptions: LettaAcpConfig["clientOptions"] =
    configFromEnv({ LETTA_ACP_BACKEND: "cloud-oauth" }).clientOptions,
): LettaAcpAgent {
  if (clientOptions.backend !== "local") throw new Error("Fake transport requires local SDK transport");
  return new LettaAcpAgent({
    clientOptions: {
      backend: "local",
      appServer: {
        ...clientOptions.appServer,
        url: "ws://fake-app-server.test/ws",
        WebSocket: server.socketConstructor(),
        requestTimeoutMs: 1_000,
        pinGlobalAgent: false,
      },
    },
    agentId: "agent-test",
    permissionMode: "standard",
    ...overrides,
  });
}

function createContext(
  options: {
    answerPermissions?: boolean;
    permissionDelayMs?: number;
    permissionOptionId?: "allow_once" | "allow_always" | "reject_once";
  } = {},
) {
  const answerPermissions = options.answerPermissions ?? true;
  const permissionDelayMs = options.permissionDelayMs ?? 0;
  const permissionOptionId = options.permissionOptionId ?? "allow_once";
  const updates: WireMessage[] = [];
  const permissionRequests: WireMessage[] = [];
  const permissionSignals: Array<AbortSignal | undefined> = [];
  const context = {
    notify: async (_method: unknown, params: { update: WireMessage }) => {
      updates.push(params.update);
    },
    request: async (
      _method: unknown,
      params: WireMessage,
      requestOptions?: { cancellationSignal?: AbortSignal },
    ) => {
      permissionRequests.push(params);
      permissionSignals.push(requestOptions?.cancellationSignal);
      if (!answerPermissions) return new Promise(() => {});
      if (permissionDelayMs > 0) {
        await Bun.sleep(permissionDelayMs);
      }
      return {
        outcome: { outcome: "selected" as const, optionId: permissionOptionId },
      };
    },
  } as unknown as AgentContext;
  return { context, updates, permissionRequests, permissionSignals };
}

async function openSession(
  agent: LettaAcpAgent,
  context: AgentContext,
  cwd = "/tmp/letta-acp-test",
) {
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  return agent.newSession({ cwd, mcpServers: [] }, context);
}

describe("Agent SDK app-server integration", () => {
  test("advertises and maps Agent SDK MCP transports", async () => {
    const servers: McpServer[] = [
      {
        name: "local",
        command: "/usr/bin/node",
        args: ["server.js"],
        env: [{ name: "TOKEN", value: "local-token" }],
      },
      {
        type: "http",
        name: "remote",
        url: "https://example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer token" }],
      },
      {
        type: "sse",
        name: "legacy",
        url: "https://example.com/sse",
        headers: [],
      },
      {
        type: "acp",
        name: "in-band",
        serverId: "server-1",
      },
    ];

    expect(toSdkMcpServers(servers)).toEqual({
      local: {
        command: "/usr/bin/node",
        args: ["server.js"],
        env: { TOKEN: "local-token" },
      },
      remote: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer token" },
      },
      legacy: {
        type: "sse",
        url: "https://example.com/sse",
        headers: {},
      },
    });

    const agent = createAgent(new FakeAppServer());
    try {
      const response = await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });
      expect(response.agentCapabilities?.mcpCapabilities).toEqual({
        http: true,
        sse: true,
      });
    } finally {
      await agent.shutdown();
    }
  });

  test("creates a named, unpinned ACP agent with the configured model", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server, { agentId: undefined });
    const { context } = createContext();

    try {
      const session = await openSession(agent, context);

      expect(session.sessionId).toBe("conv-test-2");
      expect(server.createdAgentBodies).toHaveLength(1);
      expect(server.createdAgentBodies[0]).toMatchObject({
        name: "Letta",
        description: "Letta agent driven through the Agent Client Protocol",
        model: "letta/auto",
        memory_blocks: expect.arrayContaining([
          expect.objectContaining({ label: "persona" }),
          expect.objectContaining({ label: "human" }),
        ]),
      });
      expect(server.createdAgentBodies[0]).not.toHaveProperty("hidden", true);
      expect(server.createdAgentPinGlobals).toEqual([false]);
    } finally {
      await agent.shutdown();
    }
  });

  test("uses an explicit model when creating an agent", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server, {
      agentId: undefined,
      model: "anthropic/claude-sonnet-4",
    });
    const { context } = createContext();

    try {
      await openSession(agent, context);
      expect(server.createdAgentBodies[0]).toMatchObject({
        model: "anthropic/claude-sonnet-4",
      });
      expect(server.createdAgentPinGlobals).toEqual([false]);
    } finally {
      await agent.shutdown();
    }
  });

  test("reuses an explicit agent without creating or pinning another", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server, { agentId: "agent-existing" });
    const { context } = createContext();

    try {
      await openSession(agent, context);
      expect(server.createdAgentBodies).toEqual([]);
      expect(server.createdAgentPinGlobals).toEqual([]);
      expect(server.updatedModelPayloads).toEqual([]);
    } finally {
      await agent.shutdown();
    }
  });

  test("closes a displaced session when the same conversation is loaded again", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context } = createContext();
    const params = {
      sessionId: "conv-existing",
      cwd: "/tmp/letta-acp-test",
      mcpServers: [],
    };

    try {
      await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
      await agent.loadSession(params, context);
      const closedBeforeReload = server.closedSockets;

      await agent.loadSession(params, context);

      expect(server.closedSockets).toBeGreaterThan(closedBeforeReload);
    } finally {
      await agent.shutdown();
    }
  });

  test("bounds session discovery lookups to one registry page", async () => {
    const directory = await mkdtemp(join(tmpdir(), "letta-acp-list-page-"));
    const scope = "pagination-test";
    const registry = new SessionRegistry(directory, scope);
    const cwd = "/tmp/letta-acp-test";
    for (let index = 0; index < 51; index += 1) {
      await registry.record("agent-test", `conv-page-${String(index).padStart(2, "0")}`, cwd);
    }

    const server = new FakeAppServer();
    const agent = createAgent(server, {
      sessionRegistryDir: directory,
      sessionRegistryScope: scope,
    });
    try {
      const first = await agent.listSessions({ cwd });
      expect(first.sessions).toHaveLength(50);
      expect(first.nextCursor).toBeString();
      expect(server.conversationRetrieveIds).toHaveLength(50);

      const second = await agent.listSessions({ cwd, cursor: first.nextCursor });
      expect(second.sessions).toHaveLength(1);
      expect(second.nextCursor).toBeUndefined();
      expect(server.conversationRetrieveIds).toHaveLength(51);
    } finally {
      await agent.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("removes archived and foreign sessions but retains unavailable records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "letta-acp-list-stale-"));
    const scope = "stale-test";
    const registry = new SessionRegistry(directory, scope);
    const cwd = "/tmp/letta-acp-test";
    await registry.record("agent-test", "conv-visible", cwd);
    await registry.record("agent-test", "conv-archived", cwd);
    await registry.record("agent-test", "conv-foreign", cwd);
    await registry.record("agent-test", "conv-missing", cwd);

    const server = new FakeAppServer();
    const agent = createAgent(server, {
      sessionRegistryDir: directory,
      sessionRegistryScope: scope,
    });
    try {
      const result = await agent.listSessions({ cwd });
      expect(result.sessions.map((session) => session.sessionId)).toEqual([
        "conv-visible",
      ]);
      expect(
        (await registry.list("agent-test", cwd)).map((record) => record.sessionId).sort(),
      ).toEqual(["conv-missing", "conv-visible"]);
    } finally {
      await agent.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("starts repeated sessions with distinct runtime request ids", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context } = createContext();

    try {
      const sessionIds: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        sessionIds.push((await openSession(agent, context)).sessionId);
      }

      expect(sessionIds).toEqual([
        "conv-test-1",
        "conv-test-2",
        "conv-test-3",
      ]);
      expect(new Set(server.runtimeStartRequestIds).size).toBe(3);
    } finally {
      await agent.shutdown();
    }
  });

  test("advertises available models in the session configuration", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context } = createContext();

    try {
      const session = await openSession(agent, context);

      expect(session.configOptions).toEqual([
        {
          id: "permissions",
          name: "Permissions",
          description: "Approval behavior for tool calls",
          category: "mode",
          type: "select",
          currentValue: "standard",
          options: [
            expect.objectContaining({ value: "standard", name: "Ask before edits" }),
            expect.objectContaining({ value: "acceptEdits", name: "Accept edits" }),
            expect.objectContaining({
              value: "unrestricted",
              name: "Bypass permissions",
            }),
          ],
        },
        {
          id: "model",
          name: "Model",
          description: "Model used for this Letta session",
          category: "model",
          type: "select",
          currentValue: "test/model",
          options: [
            {
              value: "test/model",
              name: "Test Model",
              description: "Deterministic test model",
            },
            {
              value: "test/other-model",
              name: "Other Model",
              description: "Alternate deterministic model",
            },
          ],
        },
      ]);
    } finally {
      await agent.shutdown();
    }
  });

  test("an off-catalog current route is listed first with a distinct (current) name", async () => {
    const server = new FakeAppServer();
    server.modelHandle = "lc-custom/unlisted-model";
    const agent = createAgent(server);
    const { context } = createContext();
    try {
      const session = await openSession(agent, context);
      const model = session.configOptions?.find((option) => option.id === "model") as
        { currentValue: string; options: Array<{ value: string; name: string }> } | undefined;
      expect(model?.currentValue).toBe("lc-custom/unlisted-model");
      expect(model?.options[0]).toEqual({ value: "lc-custom/unlisted-model", name: "lc-custom/unlisted-model (current)" });
      for (const option of model?.options ?? []) {
        expect(option.name.trim()).not.toBe("");
        expect(option.name).not.toBe(option.value);
      }
      // The value stays the exact route: reselecting it is a no-op.
      await agent.setSessionConfigOption({ sessionId: session.sessionId, configId: "model", value: "lc-custom/unlisted-model" });
      expect(server.updatedModelPayloads).toEqual([]);
    } finally {
      await agent.shutdown();
    }
  });

  test("switches models through session configuration options", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context } = createContext();

    try {
      const session = await openSession(agent, context);
      const result = await agent.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "model",
        value: "test/other-model",
      });

      expect(server.updatedModelPayloads).toEqual([{ model_id: "other-model", model_handle: "test/other-model" }]);
      expect(
        result.configOptions.find((option) => option.id === "model"),
      ).toMatchObject({
        id: "model",
        category: "model",
        currentValue: "test/other-model",
      });
    } finally {
      await agent.shutdown();
    }
  });

  for (const legacyXhigh of [true, false]) test(`Anthropic disabled and max tiers survive updates and reload (legacy xhigh: ${legacyXhigh})`, async () => {
    const server = new FakeAppServer();
    server.reasoningModel = true;
    server.anthropicReasoning = true;
    server.legacyXhigh = legacyXhigh;
    server.modelSettings = { effort: "high" };
    const agent = createAgent(server);
    const { context } = createContext();
    try {
      const { sessionId } = await openSession(agent, context);
      for (const value of ["none", "max", "high"]) {
        server.updateResponseSettings = {};
        const result = await agent.setSessionConfigOption({ sessionId, configId: "reasoning_effort", value });
        expect(result.configOptions.find((option) => option.id === "reasoning_effort"))
          .toMatchObject({ currentValue: value });
        const loaded = await agent.loadSession({ sessionId, cwd: "/tmp/letta-acp-test", mcpServers: [] }, context);
        expect(loaded.configOptions?.find((option) => option.id === "reasoning_effort"))
          .toMatchObject({ currentValue: value });
      }
      expect(server.updatedModelPayloads).toEqual([
        { model_id: "test-none", model_handle: "test/model" },
        { model_id: legacyXhigh ? "test-xhigh" : "test-max", model_handle: "test/model" },
        { model_id: "test-high", model_handle: "test/model" },
      ]);
      server.updateResponseSettings = { effort: null };
      const unknown = await agent.setSessionConfigOption({ sessionId, configId: "reasoning_effort", value: "none" });
      expect(unknown.configOptions.find((option) => option.id === "reasoning_effort")).toBeUndefined();
    } finally {
      await agent.shutdown();
    }
  });

  for (const api of ["mode", "config"]) test(`live ${api} change while approval is pending governs subsequent decisions`, async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, permissionRequests } = createContext();
    let release!: () => void;
    let requested!: () => void;
    const pending = new Promise<void>((resolve) => { requested = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const request = context.request;
    context.request = (async (...args: Parameters<typeof request>) => {
      requested();
      await gate;
      return request(...args);
    }) as typeof request;
    try {
      const { sessionId } = await openSession(agent, context);
      const started = server.nextCancelablePrompt();
      const prompt = agent.prompt({ sessionId, prompt: [{ type: "text", text: "cancel active prompt" }] }, context);
      await started;
      server.requestPermissionAfterPrompt({ requestId: "first" });
      await pending;
      if (api === "mode") await agent.setSessionMode({ sessionId, modeId: "unrestricted" }, context);
      else await agent.setSessionConfigOption({ sessionId, configId: "permissions", value: "unrestricted" });
      const approval = server.nextApprovalResponse();
      server.requestPermissionAfterPrompt({ requestId: "second", toolCallId: "second-call" });
      expect(await approval).toMatchObject({ request_id: "second", decision: { behavior: "allow" } });
      expect(permissionRequests).toHaveLength(0);
      release();
      await prompt;
    } finally {
      release?.();
      await agent.shutdown();
    }
  });

  test.each(["litellm/xai/grok-4.7", "lc-openrouter/x-ai/grok-4.7"])(
    "proxy requested efforts use the exact route and persist/reset through public SDK: %s", async (route) => {
      const server = new FakeAppServer();
      server.proxyRoute = route;
      server.proxyPresetId = route.startsWith("litellm/") ? "inventory-proxy-preset" : undefined;
      server.modelHandle = route;
      server.contextWindow = 256_000;
      server.unrelatedProxyReply = true;
      const agent = createAgent(server);
      const { context } = createContext();
      try {
        const { sessionId, configOptions } = await openSession(agent, context);
        expect(configOptions?.find((option) => option.id === "requested_reasoning_effort"))
          .toMatchObject({ name: "Requested reasoning effort", currentValue: "unknown" });
        for (const value of ["high", "max", "default"]) {
          const result = await agent.setSessionConfigOption({ sessionId, configId: "requested_reasoning_effort", value });
          expect(server.updatedModelPayloads.at(-1)).toEqual({
            model_id: server.proxyPresetId ?? route,
            model_handle: route, reasoning_effort: value === "default" ? null : value,
          });
          expect(server.contextWindow).toBe(256_000);
          expect(server.modelHandle).toBe(route);
          expect(result.configOptions.find((option) => option.id === "requested_reasoning_effort"))
            .toMatchObject({ currentValue: value });
          const loaded = await agent.loadSession({ sessionId, cwd: "/tmp/letta-acp-test", mcpServers: [] }, context);
          expect(loaded.configOptions?.find((option) => option.id === "requested_reasoning_effort"))
            .toMatchObject({ currentValue: value });
        }
        for (const value of ["unknown", "ultra", null]) {
          await expect(agent.setSessionConfigOption({
            sessionId, configId: "requested_reasoning_effort", value: value as string,
          })).rejects.toThrow("Unsupported requested effort");
        }
        expect(server.updatedModelPayloads).toHaveLength(3);
      } finally {
        await agent.shutdown();
      }
    },
  );

  test.each(["local", "cloud-oauth"] as const)(
    "%s config gates raw proxy overrides independently of advertised proxy metadata", async (backend) => {
      const server = new FakeAppServer();
      server.proxyRoute = server.modelHandle = "litellm/xai/grok-4.7";
      server.proxyPresetId = "inventory-proxy-preset";
      server.contextWindow = 256_000;
      server.modelSettings = { reasoning: null };
      const config = configFromEnv({ LETTA_ACP_BACKEND: backend });
      const agent = createAgent(server, {}, config.clientOptions);
      const { context } = createContext();
      try {
        const { sessionId, configOptions } = await openSession(agent, context);
        expect(configOptions?.some((option) => option.id === "requested_reasoning_effort"))
          .toBe(backend === "cloud-oauth");
        const state = (agent as unknown as {
          sessions: Map<string, { session: LettaCodeSession }>;
        }).sessions.get(sessionId)!;
        const sendCommand = state.session.sendCommand.bind(state.session);
        let commandCount = 0;
        state.session.sendCommand = ((...args: Parameters<LettaCodeSession["sendCommand"]>) => {
          commandCount++;
          return sendCommand(...args);
        }) as LettaCodeSession["sendCommand"];
        const change = agent.setSessionConfigOption({
          sessionId, configId: "requested_reasoning_effort", value: "high",
        });
        if (backend === "local") {
          await expect(change).rejects.toThrow("Unsupported requested effort");
          expect(commandCount).toBe(0);
          expect(server.updatedModelPayloads).toEqual([]);
          expect(server.modelSettings).toEqual({ reasoning: null });
          expect(server.contextWindow).toBe(256_000);
        } else {
          await change;
          expect(commandCount).toBeGreaterThan(0);
          expect(server.updatedModelPayloads).toEqual([{
            model_id: "inventory-proxy-preset", model_handle: server.proxyRoute, reasoning_effort: "high",
          }]);
        }
      } finally {
        await agent.shutdown();
      }
    },
  );

  test("proxy errors and malformed responses release the queue without claiming a new effort", async () => {
    const server = new FakeAppServer();
    server.proxyRoute = server.modelHandle = "litellm/xai/grok-4.7";
    server.contextWindow = 256_000;
    server.modelSettings = { reasoning: null };
    const agent = createAgent(server);
    const { context } = createContext();
    try {
      const { sessionId } = await openSession(agent, context);
      for (const response of [
        { success: false, error: "secret backend error" },
        { type: "error", error: "secret protocol error" },
        { success: true, model_handle: "wrong/route", model_settings: { reasoning: { reasoning_effort: "high" } } },
        { success: true, model_handle: server.proxyRoute, model_settings: null },
      ]) {
        server.malformedProxyResponse = response;
        await expect(agent.setSessionConfigOption({
          sessionId, configId: "requested_reasoning_effort", value: "high",
        })).rejects.toThrow("Letta requested effort update failed");
        const loaded = await agent.loadSession({ sessionId, cwd: "/tmp/letta-acp-test", mcpServers: [] }, context);
        expect(loaded.configOptions?.find((option) => option.id === "requested_reasoning_effort"))
          .toMatchObject({ currentValue: "default" });
      }
      server.malformedProxyResponse = undefined;
      await agent.setSessionConfigOption({ sessionId, configId: "requested_reasoning_effort", value: "max" });
      expect(server.modelSettings).toMatchObject({ reasoning: { reasoning_effort: "max" } });
    } finally {
      await agent.shutdown();
    }
  });

  test.each(["malformed", "normalized", "timeout", "cloud"] as const)(
    "persisted proxy update with %s acknowledgement refreshes client state and releases queue", async (failure) => {
      const server = new FakeAppServer();
      server.proxyRoute = server.modelHandle = "litellm/xai/grok-4.7";
      server.contextWindow = 256_000;
      server.modelSettings = { reasoning: null };
      const agent = createAgent(server);
      const { context, updates } = createContext();
      try {
        const { sessionId } = await openSession(agent, context);
        // Exercise the real SDK request timeout without waiting its production default.
        const state = (agent as unknown as {
          sessions: Map<string, { session: LettaCodeSession }>;
        }).sessions.get(sessionId)!;
        const sendCommand = state.session.sendCommand.bind(state.session);
        state.session.sendCommand = ((command, options) =>
          sendCommand(command, { ...options, timeoutMs: 30 })) as LettaCodeSession["sendCommand"];
        if (failure === "malformed") server.persistedProxyResponse = {
          model_settings: null, error: "secret backend credential",
        };
        if (failure === "normalized") server.normalizedProxyEffort = "low";
        if (failure === "timeout") server.persistedProxyResponse = "timeout";
        if (failure === "cloud") server.proxyCloud = true;
        await expect(agent.setSessionConfigOption({
          sessionId, configId: "requested_reasoning_effort", value: "high",
        })).rejects.toThrow("Letta requested effort update failed");
        const expected = failure === "normalized" ? "low" : failure === "cloud" ? "unknown" : "high";
        const refresh = updates.filter((update) => update.sessionUpdate === "config_option_update").at(-1);
        expect(refresh).toMatchObject({
          configOptions: expect.arrayContaining([
            expect.objectContaining({ id: "requested_reasoning_effort", currentValue: expected }),
          ]),
        });
        expect(JSON.stringify(updates)).not.toContain("secret");
        server.persistedProxyResponse = undefined;
        server.normalizedProxyEffort = undefined;
        server.proxyCloud = false;
        const next = await agent.setSessionConfigOption({
          sessionId, configId: "requested_reasoning_effort", value: "max",
        });
        expect(next.configOptions.find((option) => option.id === "requested_reasoning_effort"))
          .toMatchObject({ currentValue: "max" });
      } finally {
        await agent.shutdown();
      }
    },
  );

  test("failed proxy state hydration never becomes default or retains a stale context", async () => {
    const server = new FakeAppServer();
    server.proxyRoute = server.modelHandle = "litellm/xai/grok-4.7";
    server.contextWindow = 256_000;
    server.modelSettings = { reasoning: null };
    const agent = createAgent(server);
    const { context } = createContext();
    try {
      const { sessionId } = await openSession(agent, context);
      server.rejectModelState = true;
      const result = await agent.setSessionConfigOption({
        sessionId, configId: "requested_reasoning_effort", value: "high",
      });
      expect(result.configOptions.some((option) => option.id === "requested_reasoning_effort")).toBe(false);
      await expect(agent.setSessionConfigOption({
        sessionId, configId: "requested_reasoning_effort", value: "max",
      })).rejects.toThrow("Unsupported requested effort");
      server.rejectModelState = false;
      const loaded = await agent.loadSession({ sessionId, cwd: "/tmp/letta-acp-test", mcpServers: [] }, context);
      expect(loaded.configOptions?.find((option) => option.id === "requested_reasoning_effort"))
        .toMatchObject({ currentValue: "high" });
    } finally {
      await agent.shutdown();
    }
  });

  test("a proxy effort update blocks prompt startup and rejects new overrides during the prompt", async () => {
    const server = new FakeAppServer();
    server.proxyRoute = server.modelHandle = "litellm/xai/grok-4.7";
    server.contextWindow = 256_000;
    const agent = createAgent(server);
    const { context } = createContext();
    let release: (() => void) | undefined;
    try {
      const { sessionId } = await openSession(agent, context);
      const paused = server.pauseNextModelUpdate();
      const change = agent.setSessionConfigOption({ sessionId, configId: "requested_reasoning_effort", value: "high" });
      await paused.received;
      release = paused.release;
      const prompt = agent.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] }, context);
      await expect(agent.setSessionConfigOption({
        sessionId, configId: "requested_reasoning_effort", value: "max",
      })).rejects.toThrow("Cannot change configuration during a prompt");
      expect(server.inputModels).toEqual([]);
      release();
      await change;
      await prompt;
      expect(server.inputModels).toEqual([server.proxyRoute]);
    } finally {
      release?.();
      await agent.shutdown();
    }
  });

  test("unmarked proxy-looking routes do not get a requested-effort override", async () => {
    const server = new FakeAppServer();
    server.proxyRoute = server.modelHandle = "lc-openrouter/x-ai/grok-4.7";
    server.proxyMarked = false;
    server.contextWindow = 256_000;
    const agent = createAgent(server);
    const { context } = createContext();
    try {
      const { sessionId, configOptions } = await openSession(agent, context);
      expect(configOptions?.some((option) => option.id === "requested_reasoning_effort")).toBe(false);
      await expect(agent.setSessionConfigOption({
        sessionId, configId: "requested_reasoning_effort", value: "high",
      })).rejects.toThrow("Unsupported requested effort");
      expect(server.updatedModelPayloads).toEqual([]);
    } finally {
      await agent.shutdown();
    }
  });

  test("true local config still hydrates, persists and reloads catalog-backed reasoning through the SDK", async () => {
    const server = new FakeAppServer();
    server.reasoningModel = true;
    server.modelSettings = { reasoning: { reasoning_effort: "high" } };
    const agent = createAgent(server, {}, configFromEnv({ LETTA_ACP_BACKEND: "local" }).clientOptions);
    const { context, updates } = createContext();
    try {
      const session = await openSession(agent, context);
      expect(session.configOptions?.find((option) => option.id === "reasoning_effort"))
        .toMatchObject({ category: "thought_level", currentValue: "high" });
      expect(session.configOptions?.find((option) => option.id === "model"))
        .toMatchObject({
          currentValue: "test/model",
          options: [
            expect.objectContaining({ value: "test/model", name: "Test Model" }),
            expect.objectContaining({ value: "test/other-model" }),
          ],
        });
      await agent.setSessionConfigOption({
        sessionId: session.sessionId, configId: "model", value: "test/model",
      });
      expect(server.updatedModelPayloads).toEqual([]);
      const result = await agent.setSessionConfigOption({
        sessionId: session.sessionId, configId: "reasoning_effort", value: "low",
      });
      expect(server.updatedModelPayloads).toEqual([
        { model_id: "test-low", model_handle: "test/model" },
      ]);
      expect(result.configOptions.find((option) => option.id === "reasoning_effort"))
        .toMatchObject({ currentValue: "low" });
      expect(result.configOptions.find((option) => option.id === "model"))
        .toMatchObject({ currentValue: "test/model" });
      const loaded = await agent.loadSession({
        sessionId: session.sessionId, cwd: "/tmp/letta-acp-test", mcpServers: [],
      }, context);
      expect(loaded.configOptions?.find((option) => option.id === "reasoning_effort"))
        .toMatchObject({ currentValue: "low" });
      await agent.prompt({
        sessionId: session.sessionId, prompt: [{ type: "text", text: "/model other-model" }],
      }, context);
      const snapshot = [...updates].reverse().find((update) => update.sessionUpdate === "config_option_update");
      expect(snapshot).toBeDefined();
      expect(snapshot?.configOptions).not.toContainEqual(expect.objectContaining({ id: "reasoning_effort" }));
    } finally {
      await agent.shutdown();
    }
  });

  test("rejects unsupported effort and preserves confirmed state after runtime errors", async () => {
    const server = new FakeAppServer();
    server.reasoningModel = true;
    server.modelSettings = { effort: "high" };
    const agent = createAgent(server);
    const { context } = createContext();
    try {
      const session = await openSession(agent, context);
      for (const value of ["medium", "max", "bogus"]) {
        await expect(agent.setSessionConfigOption({
          sessionId: session.sessionId, configId: "reasoning_effort", value,
        })).rejects.toThrow("Unsupported reasoning effort");
      }
      expect(server.updatedModelPayloads).toEqual([]);
      server.rejectModelUpdate = true;
      await expect(agent.setSessionConfigOption({
        sessionId: session.sessionId, configId: "reasoning_effort", value: "low",
      })).rejects.toThrow("Letta model update failed");
      const snapshot = await agent.setSessionConfigOption({
        sessionId: session.sessionId, configId: "permissions", value: "standard",
      });
      expect(snapshot.configOptions.find((option) => option.id === "reasoning_effort"))
        .toMatchObject({ currentValue: "high" });
    } finally {
      await agent.shutdown();
    }
  });

  test("omits unknown effort until an explicit model preset confirms a tier", async () => {
    const server = new FakeAppServer();
    server.reasoningModel = true;
    const agent = createAgent(server);
    const { context } = createContext();
    try {
      const session = await openSession(agent, context);
      expect(session.configOptions?.some((option) => option.id === "reasoning_effort")).toBe(false);
      const selected = await agent.setSessionConfigOption({
        sessionId: session.sessionId, configId: "model", value: "test-high",
      });
      expect(selected.configOptions.find((option) => option.id === "reasoning_effort"))
        .toMatchObject({ currentValue: "high", category: "thought_level" });
    } finally {
      await agent.shutdown();
    }
  });

  test("serializes overlapping model and effort updates and reuses the pre-update catalog", async () => {
    const server = new FakeAppServer();
    server.reasoningModel = true;
    server.alternateReasoning = true;
    server.modelSettings = { effort: "high" };
    server.contextWindow = 100_000;
    const agent = createAgent(server);
    const { context } = createContext();
    try {
      const { sessionId } = await openSession(agent, context);
      const gate = server.pauseNextModelUpdate();
      const model = agent.setSessionConfigOption({ sessionId, configId: "model", value: "other-high" });
      await gate.received;
      const effort = agent.setSessionConfigOption({ sessionId, configId: "reasoning_effort", value: "low" });
      server.rejectCatalog = true;
      gate.release();
      await model;
      const result = await effort;
      expect(server.updatedModelPayloads).toEqual([
        { model_id: "other-high" },
        { model_id: "other-low", model_handle: "test/other-model" },
      ]);
      expect(result.configOptions.find((option) => option.id === "model"))
        .toMatchObject({ currentValue: "test/other-model" });
      expect(result.configOptions.find((option) => option.id === "reasoning_effort"))
        .toMatchObject({ currentValue: "low" });
      expect(server.catalogRequests).toBe(1);
    } finally {
      await agent.shutdown();
    }
  });

  test("prompt waits for admitted changes, rejects new changes, and slash model does not deadlock", async () => {
    const server = new FakeAppServer();
    server.reasoningModel = true;
    server.modelSettings = { effort: "high" };
    const agent = createAgent(server);
    const { context, updates } = createContext();
    try {
      const { sessionId } = await openSession(agent, context);
      const gate = server.pauseNextModelUpdate();
      const change = agent.setSessionConfigOption({ sessionId, configId: "model", value: "test-low" });
      await gate.received;
      const prompt = agent.prompt({ sessionId, prompt: [{ type: "text", text: "/model test-high" }] }, context);
      await expect(agent.setSessionConfigOption({ sessionId, configId: "reasoning_effort", value: "low" }))
        .rejects.toThrow("Cannot change configuration during a prompt");
      await expect(agent.setSessionMode({ sessionId, modeId: "unrestricted" }, context))
        .resolves.toEqual({});
      await expect(agent.setSessionConfigOption({ sessionId, configId: "permissions", value: "standard" }))
        .resolves.toHaveProperty("configOptions");
      await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] }, context))
        .rejects.toThrow("already active");
      expect(server.updatedModelPayloads).toEqual([]);
      gate.release();
      await change;
      await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
      expect(server.updatedModelPayloads).toEqual([{ model_id: "test-low" }, { model_id: "test-high" }]);
      const snapshot = [...updates].reverse().find((update) => update.sessionUpdate === "config_option_update");
      expect(snapshot?.configOptions).toContainEqual(expect.objectContaining({ id: "reasoning_effort", currentValue: "high" }));
      await agent.setSessionConfigOption({ sessionId, configId: "reasoning_effort", value: "low" });
    } finally {
      await agent.shutdown();
    }
  });

  test("a normal prompt sends only after an in-flight model update has completed", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context } = createContext();
    try {
      const { sessionId } = await openSession(agent, context);
      const gate = server.pauseNextModelUpdate();
      const change = agent.setSessionConfigOption({ sessionId, configId: "model", value: "other-model" });
      await gate.received;
      const prompt = agent.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] }, context);
      expect(server.inputModels).toEqual([]);
      await expect(agent.setSessionConfigOption({ sessionId, configId: "model", value: "test-model" }))
        .rejects.toThrow("during a prompt");
      gate.release();
      await change;
      await prompt;
      expect(server.inputModels).toEqual(["test/other-model"]);
    } finally {
      await agent.shutdown();
    }
  });

  test("failed queued update does not poison the next update or prompt", async () => {
    const server = new FakeAppServer();
    server.reasoningModel = true;
    const agent = createAgent(server);
    const { context } = createContext();
    try {
      const { sessionId } = await openSession(agent, context);
      const gate = server.pauseNextModelUpdate();
      server.rejectModelUpdate = true;
      const failed = agent.setSessionConfigOption({ sessionId, configId: "model", value: "test-low" });
      const rejection = expect(failed).rejects.toThrow("Letta model update failed");
      await gate.received;
      const next = agent.setSessionConfigOption({ sessionId, configId: "model", value: "test-high" });
      gate.release();
      server.rejectModelUpdate = false;
      await rejection;
      await next;
      await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "/model" }] }, context))
        .resolves.toEqual({ stopReason: "end_turn" });
    } finally {
      await agent.shutdown();
    }
  });

  test("canonicalizes persisted preset ids and uses runtime context rather than preset limits", async () => {
    const server = new FakeAppServer();
    server.reasoningModel = true;
    server.alternateReasoning = true;
    server.alternateWindows = true;
    server.modelHandle = "test-high";
    server.modelSettings = { effort: "high" };
    const agent = createAgent(server);
    const { context } = createContext();
    try {
      const { sessionId } = await openSession(agent, context);
      await agent.setSessionConfigOption({ sessionId, configId: "reasoning_effort", value: "low" });
      expect(server.updatedModelPayloads[0]).toEqual({ model_id: "test-low", model_handle: "test/model" });
      server.contextWindow = 42_000;
      const result = await agent.setSessionConfigOption({ sessionId, configId: "model", value: "other-high" });
      // This route's presets are sparse (no low at 200K): one selector lists
      // only real presets, beside the runtime-reported off-grid state.
      expect(result.configOptions.some((option) => ["reasoning_effort", "context_window"].includes(option.id))).toBe(false);
      expect(result.configOptions.find((option) => option.id === "letta_preset")).toMatchObject({
        currentValue: "current",
        options: [
          { value: "current", name: "high · 42K tokens (current, not a Letta preset)" },
          { value: "other-low", name: "low · 100K tokens" },
          { value: "other-high", name: "high · 100K tokens" },
          { value: "other-high-large", name: "high · 200K tokens" },
        ],
      });
    } finally {
      await agent.shutdown();
    }
  });

  describe("Letta preset grid: separate effort and context size", () => {
    const LUNA = "chatgpt-plus-pro/gpt-6-luna";
    const ALL_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];
    type Options = Array<{ id: string; currentValue?: unknown; options?: unknown }> | undefined | null;
    const find = (options: Options, id: string) => options?.find((option) => option.id === id) as
      | { currentValue: string; description?: string; options: Array<{ value: string; name: string }> }
      | undefined;
    const values = (options: Options, id: string) => find(options, id)?.options.map((option) => option.value);

    function lunaServer(effort: string, window: number) {
      const server = new FakeAppServer();
      server.lunaCatalog = true;
      server.modelHandle = LUNA;
      server.modelSettings = { provider_type: "chatgpt_oauth", reasoning: { reasoning_effort: effort } };
      server.contextWindow = window;
      return server;
    }

    /**
     * T3's send path, from its installed source: model first, then the stored
     * selections in option order, each checked against ONE options snapshot
     * (values missing from it are skipped), skipping values whose live
     * currentValue already matches; rejections are only logged.
     */
    async function t3Send(
      agent: LettaAcpAgent, sessionId: string, snapshot: Options,
      selections: Array<{ id: string; value: string }>,
    ) {
      const order = (snapshot ?? []).map((option) => option.id);
      const ordered = [...selections].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      let live = snapshot;
      const rejected: unknown[] = [];
      for (const selection of ordered) {
        const option = find(snapshot, selection.id);
        if (!option?.options.some((choice) => choice.value === selection.value)) continue;
        if (find(live, selection.id)?.currentValue === selection.value) continue;
        try {
          live = (await agent.setSessionConfigOption({ sessionId, configId: selection.id, value: selection.value })).configOptions;
        } catch (error) {
          rejected.push(error);
        }
      }
      return { live, rejected };
    }
    const ids = (options: Options) => options?.map((option) => option.id);

    test("off-grid 1.05M shows the true state beside every preset choice and writes nothing until chosen", async () => {
      const server = lunaServer("low", 1_050_000);
      const agent = createAgent(server);
      const { context } = createContext();
      try {
        const { sessionId, configOptions } = await openSession(agent, context);
        expect(ids(configOptions)).toEqual(["permissions", "model", "context_window", "reasoning_effort"]);
        expect(find(configOptions, "model")).toMatchObject({ currentValue: LUNA });
        expect(find(configOptions, "model")?.options[0]).toEqual({ value: LUNA, name: "GPT-6 Luna" });
        expect(find(configOptions, "model")?.options.filter((option) => option.value === LUNA)).toHaveLength(1);
        expect(find(configOptions, "context_window")).toMatchObject({
          category: "model_config",
          currentValue: "1050000",
          options: [
            { value: "350000", name: "350K tokens" },
            { value: "950000", name: "950K tokens" },
            { value: "1050000", name: "1.05M tokens (current, not a Letta preset)" },
          ],
        });
        expect(find(configOptions, "reasoning_effort")).toMatchObject({
          category: "thought_level",
          currentValue: "low",
          description: expect.stringContaining("moves the context size to that preset's window"),
          options: ALL_EFFORTS.map((value) => ({ value, name: value })),
        });
        for (const [configId, value] of [["reasoning_effort", "low"], ["context_window", "1050000"], ["model", LUNA]]) {
          await agent.setSessionConfigOption({ sessionId, configId: configId!, value: value! });
        }
        for (const value of ["ultra", "unknown", "minimal"]) {
          await expect(agent.setSessionConfigOption({ sessionId, configId: "reasoning_effort", value }))
            .rejects.toThrow("Unsupported reasoning effort");
        }
        for (const value of ["123456", "1050001", "custom", "0", ""]) {
          await expect(agent.setSessionConfigOption({ sessionId, configId: "context_window", value }))
            .rejects.toThrow("Unsupported context size");
        }
        await expect(agent.setSessionConfigOption({ sessionId, configId: "letta_preset", value: "luna-high" }))
          .rejects.toThrow("Unsupported Letta preset");
        expect(server.updatedModelPayloads).toEqual([]);
        expect(server.contextUpdates).toEqual([]);
        expect(server.contextWindow).toBe(1_050_000);
      } finally {
        await agent.shutdown();
      }
    });

    for (const preserveWindow of [false, true]) test(`T3 send of High only from off-grid 1.05M ends on a real preset (runtime keeps window: ${preserveWindow})`, async () => {
      const server = lunaServer("low", 1_050_000);
      server.preserveWindow = preserveWindow;
      const agent = createAgent(server);
      const { context } = createContext();
      try {
        const { sessionId, configOptions } = await openSession(agent, context);
        const { live, rejected } = await t3Send(agent, sessionId, configOptions, [{ id: "reasoning_effort", value: "high" }]);
        expect(rejected).toEqual([]);
        // First catalog High preset is the 350K one; its window is applied, not the off-grid one kept.
        expect(server.updatedModelPayloads).toEqual([{ model_id: "luna-high", model_handle: LUNA }]);
        expect(server.contextUpdates.map((update) => update.body))
          .toEqual(preserveWindow ? [{ context_window_limit: 350_000 }] : []);
        expect(server.contextWindow).toBe(350_000);
        expect(server.modelSettings).toEqual({ provider_type: "chatgpt_oauth", reasoning: { reasoning_effort: "high" } });
        expect(find(live, "reasoning_effort")).toMatchObject({ currentValue: "high" });
        expect(find(live, "context_window")).toMatchObject({
          currentValue: "350000",
          options: [{ value: "350000", name: "350K tokens" }, { value: "950000", name: "950K tokens" }],
        });
        await expect(agent.setSessionConfigOption({ sessionId, configId: "context_window", value: "1050000" }))
          .rejects.toThrow("Unsupported context size");
      } finally {
        await agent.shutdown();
      }
    });

    test("T3 send of 950K + High in one snapshot reaches exactly that preset; reactivation is stable", async () => {
      const server = lunaServer("low", 1_050_000);
      const agent = createAgent(server);
      const { context } = createContext();
      const selections = [{ id: "reasoning_effort", value: "high" }, { id: "context_window", value: "950000" }];
      try {
        const { sessionId, configOptions } = await openSession(agent, context);
        const { live, rejected } = await t3Send(agent, sessionId, configOptions, selections);
        expect(rejected).toEqual([]);
        // Context is listed first, so it is applied first and no 350K preset is written on the way.
        expect(server.contextUpdates.map((update) => update.body)).toEqual([{ context_window_limit: 950_000 }]);
        expect(server.updatedModelPayloads).toEqual([{ model_id: "luna-1m-high", model_handle: LUNA }]);
        expect(find(live, "context_window")).toMatchObject({ currentValue: "950000" });
        expect(find(live, "reasoning_effort")).toMatchObject({ currentValue: "high" });

        const reloaded = await agent.loadSession({ sessionId, cwd: "/tmp/letta-acp-test", mcpServers: [] }, context);
        await t3Send(agent, sessionId, reloaded.configOptions, selections);
        expect(server.contextUpdates).toHaveLength(1);
        expect(server.updatedModelPayloads).toHaveLength(1);
      } finally {
        await agent.shutdown();
      }
    });

    test("effort keeps the chosen window and context keeps the chosen effort, across reload", async () => {
      const server = lunaServer("low", 350_000);
      const agent = createAgent(server);
      const { context } = createContext();
      try {
        const { sessionId, configOptions } = await openSession(agent, context);
        expect(values(configOptions, "reasoning_effort")).toEqual(ALL_EFFORTS);
        expect(values(configOptions, "context_window")).toEqual(["350000", "950000"]);
        expect(find(configOptions, "reasoning_effort")?.description).toContain("keeps the context size");

        await agent.setSessionConfigOption({ sessionId, configId: "context_window", value: "950000" });
        const effort = await agent.setSessionConfigOption({ sessionId, configId: "reasoning_effort", value: "high" });
        expect(server.updatedModelPayloads).toEqual([{ model_id: "luna-1m-high", model_handle: LUNA }]);
        expect(find(effort.configOptions, "context_window")).toMatchObject({ currentValue: "950000" });
        expect(find(effort.configOptions, "reasoning_effort")).toMatchObject({ currentValue: "high" });

        const context350 = await agent.setSessionConfigOption({ sessionId, configId: "context_window", value: "350000" });
        expect(find(context350.configOptions, "reasoning_effort")).toMatchObject({ currentValue: "high" });
        expect(server.modelSettings).toEqual({ provider_type: "chatgpt_oauth", reasoning: { reasoning_effort: "high" } });
        expect(server.modelHandle).toBe(LUNA);

        const loaded = await agent.loadSession({ sessionId, cwd: "/tmp/letta-acp-test", mcpServers: [] }, context);
        expect(find(loaded.configOptions, "reasoning_effort")).toMatchObject({ currentValue: "high" });
        expect(find(loaded.configOptions, "context_window")).toMatchObject({ currentValue: "350000" });
        expect(server.contextUpdates.map((update) => update.body)).toEqual([
          { context_window_limit: 950_000 }, { context_window_limit: 350_000 },
        ]);
        expect(server.updatedModelPayloads).toHaveLength(1);
      } finally {
        await agent.shutdown();
      }
    });

    test("an unreported effort is shown as such beside every tier; a window choice adopts that window's first real preset", async () => {
      const server = lunaServer("low", 350_000);
      server.modelSettings = { provider_type: "chatgpt_oauth", reasoning: null };
      const agent = createAgent(server);
      const { context } = createContext();
      try {
        const { sessionId, configOptions } = await openSession(agent, context);
        expect(find(configOptions, "reasoning_effort")).toMatchObject({
          currentValue: "unknown",
          options: [{ value: "unknown", name: "Not reported" }, ...ALL_EFFORTS.map((value) => ({ value, name: value }))],
        });
        await agent.setSessionConfigOption({ sessionId, configId: "reasoning_effort", value: "unknown" });
        expect(server.updatedModelPayloads).toEqual([]);
        const result = await agent.setSessionConfigOption({ sessionId, configId: "context_window", value: "950000" });
        expect(server.updatedModelPayloads).toEqual([{ model_id: "luna-1m-none", model_handle: LUNA }]);
        expect(server.contextUpdates).toEqual([]);
        expect(find(result.configOptions, "reasoning_effort")).toMatchObject({ currentValue: "none" });
        expect(find(result.configOptions, "context_window")).toMatchObject({ currentValue: "950000" });
      } finally {
        await agent.shutdown();
      }
    });

    test("a sparse grid offers one selector of real presets and never an impossible pair", async () => {
      const server = new FakeAppServer();
      server.opusCatalog = true;
      server.modelHandle = "anthropic/claude-opus-5";
      server.modelSettings = { provider_type: "anthropic", effort: "low" };
      server.contextWindow = 1_000_000;
      const agent = createAgent(server);
      const { context } = createContext();
      try {
        const { sessionId, configOptions } = await openSession(agent, context);
        expect(find(configOptions, "reasoning_effort")).toBeUndefined();
        expect(find(configOptions, "context_window")).toBeUndefined();
        expect(find(configOptions, "letta_preset")).toMatchObject({
          name: "Reasoning & context",
          category: "thought_level",
          currentValue: "current",
          options: [
            { value: "current", name: "low · 1M tokens (current, not a Letta preset)" },
            { value: "opus-5-low", name: "low · 200K tokens" },
            { value: "opus-5-medium", name: "medium · 200K tokens" },
            { value: "opus-5-high", name: "high · 200K tokens" },
            { value: "opus-5-xhigh", name: "xhigh · 200K tokens" },
            { value: "opus-5-max", name: "max · 200K tokens" },
            { value: "opus-5-1m", name: "high · 950K tokens" },
          ],
        });
        await agent.setSessionConfigOption({ sessionId, configId: "letta_preset", value: "current" });
        for (const [configId, value] of [["letta_preset", "opus-5-low-1m"], ["reasoning_effort", "high"], ["context_window", "950000"]]) {
          await expect(agent.setSessionConfigOption({ sessionId, configId: configId!, value: value! })).rejects.toThrow("Unsupported");
        }
        expect(server.updatedModelPayloads).toEqual([]);
        const { live } = await t3Send(agent, sessionId, configOptions, [{ id: "letta_preset", value: "opus-5-1m" }]);
        expect(server.updatedModelPayloads).toEqual([{ model_id: "opus-5-1m", model_handle: "anthropic/claude-opus-5" }]);
        expect(find(live, "letta_preset")).toMatchObject({ currentValue: "opus-5-1m" });
        expect(values(live, "letta_preset")).not.toContain("current");
        await t3Send(agent, sessionId, live, [{ id: "letta_preset", value: "opus-5-1m" }]);
        expect(server.updatedModelPayloads).toHaveLength(1);
      } finally {
        await agent.shutdown();
      }
    });

    test("a failed window correction after a preset update reports the actual state and releases the queue", async () => {
      const server = lunaServer("low", 1_050_000);
      server.preserveWindow = true;
      server.rejectContextUpdate = true;
      const agent = createAgent(server);
      const { context, updates } = createContext();
      try {
        const { sessionId } = await openSession(agent, context);
        await expect(agent.setSessionConfigOption({ sessionId, configId: "reasoning_effort", value: "high" }))
          .rejects.toThrow("Letta context window update failed");
        const refresh = updates.filter((update) => update.sessionUpdate === "config_option_update").at(-1);
        expect(find(refresh?.configOptions as Options, "reasoning_effort")).toMatchObject({ currentValue: "high" });
        expect(find(refresh?.configOptions as Options, "context_window")).toMatchObject({ currentValue: "1050000" });
        expect(JSON.stringify(updates)).not.toContain("secret");
        server.rejectContextUpdate = false;
        const next = await agent.setSessionConfigOption({ sessionId, configId: "context_window", value: "350000" });
        expect(find(next.configOptions, "context_window")).toMatchObject({ currentValue: "350000" });
        expect(find(next.configOptions, "reasoning_effort")).toMatchObject({ currentValue: "high" });
      } finally {
        await agent.shutdown();
      }
    });

    test("default conversation writes the agent scope", async () => {
      const server = lunaServer("medium", 350_000);
      server.defaultConversation = true;
      server.agentModel = LUNA;
      server.agentSettings = server.modelSettings;
      server.agentContextWindow = 350_000;
      server.contextWindow = undefined;
      const agent = createAgent(server);
      const { context } = createContext();
      try {
        const { sessionId, configOptions } = await openSession(agent, context);
        expect(sessionId).toBe("default");
        expect(find(configOptions, "context_window")).toMatchObject({ currentValue: "350000" });
        const result = await agent.setSessionConfigOption({ sessionId, configId: "context_window", value: "950000" });
        expect(server.contextUpdates).toEqual([{ scope: "agent", body: { context_window_limit: 950_000 } }]);
        expect(find(result.configOptions, "context_window")).toMatchObject({ currentValue: "950000" });
        expect(find(result.configOptions, "reasoning_effort")).toMatchObject({ currentValue: "medium" });
        expect(server.conversationRetrieveIds).toEqual([]);
      } finally {
        await agent.shutdown();
      }
    });

    for (const failure of ["rejected", "unconfirmed"] as const) test(`${failure} context write reports persisted state and releases the queue`, async () => {
      const server = lunaServer("low", 350_000);
      if (failure === "rejected") server.rejectContextUpdate = true;
      else server.ignoreContextUpdate = true;
      const agent = createAgent(server);
      const { context, updates } = createContext();
      try {
        const { sessionId } = await openSession(agent, context);
        await expect(agent.setSessionConfigOption({ sessionId, configId: "context_window", value: "950000" }))
          .rejects.toThrow(failure === "rejected" ? "Letta context window update failed" : "did not confirm");
        const refresh = updates.filter((update) => update.sessionUpdate === "config_option_update").at(-1);
        expect(find(refresh?.configOptions as Options, "context_window")).toMatchObject({ currentValue: "350000" });
        expect(JSON.stringify(updates)).not.toContain("secret");
        server.rejectContextUpdate = server.ignoreContextUpdate = false;
        const next = await agent.setSessionConfigOption({ sessionId, configId: "context_window", value: "950000" });
        expect(find(next.configOptions, "context_window")).toMatchObject({ currentValue: "950000" });
      } finally {
        await agent.shutdown();
      }
    });

    test("a prompt waits for an admitted context change and rejects new ones while active", async () => {
      const server = lunaServer("low", 350_000);
      const agent = createAgent(server);
      const { context } = createContext();
      let release: (() => void) | undefined;
      try {
        const { sessionId } = await openSession(agent, context);
        const paused = server.pauseNextModelUpdate();
        const change = agent.setSessionConfigOption({ sessionId, configId: "context_window", value: "950000" });
        await paused.received;
        release = paused.release;
        const prompt = agent.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] }, context);
        await expect(agent.setSessionConfigOption({ sessionId, configId: "context_window", value: "350000" }))
          .rejects.toThrow("Cannot change configuration during a prompt");
        expect(server.inputModels).toEqual([]);
        release();
        await change;
        await prompt;
        expect(server.inputModels).toEqual([LUNA]);
        expect(server.contextWindow).toBe(950_000);
      } finally {
        release?.();
        await agent.shutdown();
      }
    });

    test("refreshes after prompts and slash commands, notifying only on change", async () => {
      const server = lunaServer("low", 350_000);
      const agent = createAgent(server);
      // The fake command requests one approval; answer it like the command recovery test.
      const { context, updates } = createContext({ permissionDelayMs: 10 });
      const snapshots = () => updates.filter((update) => update.sessionUpdate === "config_option_update");
      // A no-op queued mutation resolves after the post-prompt refresh.
      const settle = (sessionId: string) =>
        agent.setSessionConfigOption({ sessionId, configId: "reasoning_effort", value: "low" });
      try {
        const { sessionId } = await openSession(agent, context);
        await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] }, context);
        await settle(sessionId);
        expect(snapshots()).toHaveLength(0);

        // e.g. /context-limit or another client changed persisted state.
        // The fake reuses a run id per prompt kind, so each turn uses a distinct kind.
        server.contextWindow = 950_000;
        await agent.prompt({ sessionId, prompt: [{ type: "text", text: "edit prompt" }] }, context);
        const settled = await settle(sessionId);
        expect(find(snapshots().at(-1)?.configOptions as Options, "context_window")).toMatchObject({ currentValue: "950000" });
        expect(find(settled.configOptions, "context_window")).toMatchObject({ currentValue: "950000" });
        expect(snapshots()).toHaveLength(1);

        server.contextWindow = 1_050_000;
        await agent.prompt({ sessionId, prompt: [{ type: "text", text: "/compact" }] }, context);
        await settle(sessionId);
        expect(find(snapshots().at(-1)?.configOptions as Options, "context_window")).toMatchObject({ currentValue: "1050000" });

        // A failed read keeps the last confirmed state rather than hiding it.
        server.rejectModelState = true;
        await agent.prompt({ sessionId, prompt: [{ type: "text", text: "fragmented prompt" }] }, context);
        const kept = await settle(sessionId);
        expect(find(kept.configOptions, "reasoning_effort")).toMatchObject({ currentValue: "low" });
        expect(find(kept.configOptions, "context_window")).toMatchObject({ currentValue: "1050000" });
        expect(server.updatedModelPayloads).toEqual([]);
        expect(server.contextUpdates).toEqual([]);
      } finally {
        await agent.shutdown();
      }
    });

    test("a change requested right after a prompt is applied after, and not undone by, its refresh", async () => {
      const server = lunaServer("low", 350_000);
      const agent = createAgent(server);
      const { context, updates } = createContext();
      try {
        const { sessionId } = await openSession(agent, context);
        await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] }, context);
        const result = await agent.setSessionConfigOption({ sessionId, configId: "context_window", value: "950000" });
        expect(find(result.configOptions, "context_window")).toMatchObject({ currentValue: "950000" });
        await agent.setSessionConfigOption({ sessionId, configId: "reasoning_effort", value: "low" });
        const stale = updates.filter((update) => update.sessionUpdate === "config_option_update")
          .some((update) => find(update.configOptions as Options, "context_window")?.currentValue === "350000");
        expect(stale).toBe(false);
        expect(server.contextWindow).toBe(950_000);
      } finally {
        await agent.shutdown();
      }
    });

    test("a refresh for a displaced session does not notify its old client", async () => {
      const server = lunaServer("low", 350_000);
      const agent = createAgent(server);
      const first = createContext();
      const second = createContext();
      let release: (() => void) | undefined;
      try {
        const { sessionId } = await openSession(agent, first.context);
        const sessions = (agent as unknown as { sessions: Map<string, { configTail: Promise<void> }> }).sessions;
        const displaced = sessions.get(sessionId)!;
        server.contextWindow = 950_000;
        const paused = server.pauseNextAgentRetrieve();
        await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] }, first.context);
        await paused.received;
        release = paused.release;
        const loaded = await agent.loadSession({ sessionId, cwd: "/tmp/letta-acp-test", mcpServers: [] }, second.context);
        expect(find(loaded.configOptions, "context_window")).toMatchObject({ currentValue: "950000" });
        release();
        await displaced.configTail;
        expect(first.updates.filter((update) => update.sessionUpdate === "config_option_update")).toEqual([]);
      } finally {
        release?.();
        await agent.shutdown();
      }
    });

    test("same-effort presets differing beyond context_window use the real-preset selector", async () => {
      const server = lunaServer("low", 350_000);
      server.lunaDivergent = true;
      const agent = createAgent(server);
      const { context } = createContext();
      try {
        const { sessionId, configOptions } = await openSession(agent, context);
        expect(find(configOptions, "context_window")).toBeUndefined();
        expect(find(configOptions, "reasoning_effort")).toBeUndefined();
        expect(find(configOptions, "letta_preset")).toMatchObject({ currentValue: "luna-low" });
        expect(values(configOptions, "letta_preset")).toHaveLength(12);
        await expect(agent.setSessionConfigOption({ sessionId, configId: "context_window", value: "950000" }))
          .rejects.toThrow("Unsupported context size");
        await agent.setSessionConfigOption({ sessionId, configId: "letta_preset", value: "luna-1m-low" });
        expect(server.updatedModelPayloads).toEqual([{ model_id: "luna-1m-low", model_handle: LUNA }]);
        expect(server.contextUpdates).toEqual([]);
      } finally {
        await agent.shutdown();
      }
    });

    test("a route without effort presets shows no effort selector, even with a persisted effort", async () => {
      const server = new FakeAppServer();
      server.modelHandle = "test/other-model";
      server.modelSettings = { provider_type: "openai", reasoning: { reasoning_effort: "high" } };
      server.contextWindow = 100_000;
      const agent = createAgent(server);
      const { context } = createContext();
      try {
        const { configOptions } = await openSession(agent, context);
        expect(find(configOptions, "reasoning_effort")).toBeUndefined();
        expect(find(configOptions, "context_window")).toBeUndefined();
      } finally {
        await agent.shutdown();
      }
    });

    test("windowless presets are not applied at the legacy 128000 clamp the runtime would resize", async () => {
      const server = new FakeAppServer();
      server.reasoningModel = true;
      server.modelSettings = { effort: "high" };
      server.contextWindow = 128_000;
      const agent = createAgent(server);
      const { context } = createContext();
      try {
        const { sessionId, configOptions } = await openSession(agent, context);
        expect(find(configOptions, "reasoning_effort")).toMatchObject({
          currentValue: "high",
          description: expect.stringContaining("use /model"),
          options: [{ value: "high", name: "high (current, not a Letta preset here)" }],
        });
        await expect(agent.setSessionConfigOption({ sessionId, configId: "reasoning_effort", value: "low" }))
          .rejects.toThrow("Unsupported reasoning effort");
        expect(server.updatedModelPayloads).toEqual([]);
        server.contextWindow = 100_000;
        const loaded = await agent.loadSession({ sessionId, cwd: "/tmp/letta-acp-test", mcpServers: [] }, context);
        expect(values(loaded.configOptions, "reasoning_effort")).toEqual(["low", "high"]);
      } finally {
        await agent.shutdown();
      }
    });

    test("model switch keeps the model menu's current route first", async () => {
      const server = lunaServer("low", 350_000);
      const agent = createAgent(server);
      const { context } = createContext();
      try {
        const { sessionId } = await openSession(agent, context);
        const switched = await agent.setSessionConfigOption({ sessionId, configId: "model", value: "test/other-model" });
        expect(server.updatedModelPayloads).toEqual([{ model_id: "other-model", model_handle: "test/other-model" }]);
        expect(find(switched.configOptions, "model")?.options[0]?.value).toBe("test/other-model");
        expect(find(switched.configOptions, "model")?.options.map((option) => option.value).sort())
          .toEqual([LUNA, "test/model", "test/other-model"].sort());
        const back = await agent.setSessionConfigOption({ sessionId, configId: "model", value: LUNA });
        expect(server.updatedModelPayloads.at(-1)).toEqual({ model_id: "luna-medium", model_handle: LUNA });
        expect(find(back.configOptions, "context_window")).toMatchObject({ currentValue: "350000" });
        expect(find(back.configOptions, "reasoning_effort")).toMatchObject({ currentValue: "medium" });
      } finally {
        await agent.shutdown();
      }
    });
  });

  test("switches permission enforcement through session config options", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, permissionRequests } = createContext();

    try {
      const session = await openSession(agent, context);
      const result = await agent.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "permissions",
        value: "unrestricted",
      });
      expect(
        result.configOptions.find((option) => option.id === "permissions"),
      ).toMatchObject({
        category: "mode",
        currentValue: "unrestricted",
      });

      await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "plain prompt" }],
        },
        context,
      );
      const approval = server.nextApprovalResponse();
      server.requestPermissionAfterPrompt();

      expect(await approval).toMatchObject({
        decision: { behavior: "allow" },
      });
      expect(permissionRequests).toEqual([]);
    } finally {
      await agent.shutdown();
    }
  });

  test("streams an assistant response through a complete prompt turn", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, updates } = createContext();

    try {
      const session = await openSession(agent, context);
      const result = await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "plain prompt" }],
        },
        context,
      );

      expect(result).toEqual({ stopReason: "end_turn" });
      expect(updates).toContainEqual({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "PROMPT_OK" },
      });
    } finally {
      await agent.shutdown();
    }
  });

  test("streams fragmented tool arguments as one tool card", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, updates } = createContext();

    try {
      const session = await openSession(agent, context);
      const result = await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "fragmented prompt" }],
        },
        context,
      );
      expect(result).toEqual({ stopReason: "end_turn" });

      expect(
        updates.filter((update) => update.toolCallId === "call-fragmented"),
      ).toEqual([
        {
          sessionUpdate: "tool_call",
          toolCallId: "call-fragmented",
          title: "Bash",
          kind: "execute",
          status: "in_progress",
          rawInput: { raw: '{"command":"git status"' },
          locations: [],
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-fragmented",
          title: "Show the working tree status",
          kind: "execute",
          status: "in_progress",
          rawInput: {
            command: "git status",
            description: "Show the working tree status",
          },
          locations: [],
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-fragmented",
          status: "completed",
          rawOutput: "nothing to commit",
          content: [
            {
              type: "content",
              content: { type: "text", text: "nothing to commit" },
            },
          ],
        },
      ]);
    } finally {
      await agent.shutdown();
    }
  });

  test("renders Bash output as a native terminal when the client supports it", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, updates } = createContext();

    try {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: { _meta: { terminal_output: true } },
      });
      const session = await agent.newSession(
        { cwd: "/tmp/letta-acp-test", mcpServers: [] },
        context,
      );
      const result = await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "fragmented prompt" }],
        },
        context,
      );

      expect(result).toEqual({ stopReason: "end_turn" });
      expect(
        updates.filter((update) => update.toolCallId === "call-fragmented"),
      ).toEqual([
        {
          sessionUpdate: "tool_call",
          toolCallId: "call-fragmented",
          title: "Bash",
          kind: "execute",
          status: "in_progress",
          rawInput: { raw: '{"command":"git status"' },
          locations: [],
          content: [{ type: "terminal", terminalId: "call-fragmented" }],
          _meta: {
            terminal_info: {
              terminal_id: "call-fragmented",
              cwd: "/tmp/letta-acp-test",
            },
          },
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-fragmented",
          title: "Show the working tree status",
          kind: "execute",
          status: "in_progress",
          rawInput: {
            command: "git status",
            description: "Show the working tree status",
          },
          locations: [],
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-fragmented",
          _meta: {
            terminal_output: {
              terminal_id: "call-fragmented",
              data: "nothing to commit",
            },
          },
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-fragmented",
          status: "completed",
          rawOutput: "nothing to commit",
          content: [
            { type: "terminal", terminalId: "call-fragmented" },
            {
              type: "content",
              content: { type: "text", text: "nothing to commit" },
            },
          ],
          _meta: {
            terminal_exit: {
              terminal_id: "call-fragmented",
              exit_code: 0,
              signal: null,
            },
          },
        },
      ]);
    } finally {
      await agent.shutdown();
    }
  });

  test("renders an SDK Edit call as a native ACP diff", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, updates } = createContext();

    try {
      const session = await openSession(agent, context);
      const result = await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "edit prompt" }],
        },
        context,
      );

      expect(result).toEqual({ stopReason: "end_turn" });
      expect(updates).toContainEqual(
        expect.objectContaining({
          sessionUpdate: "tool_call",
          toolCallId: "call-edit",
          content: [
            {
              type: "diff",
              path: "/tmp/example.ts",
              oldText: "const value = 1;",
              newText: "const value = 2;",
            },
          ],
        }),
      );
      const completed = updates.find(
        (update) =>
          update.sessionUpdate === "tool_call_update" &&
          update.toolCallId === "call-edit" &&
          update.status === "completed",
      );
      expect(completed).toEqual(
        expect.objectContaining({
          rawOutput: {
            message: "Successfully replaced 1 occurrence",
            replacements: 1,
            startLine: 12,
          },
          locations: [{ path: "/tmp/example.ts", line: 12 }],
        }),
      );
      expect(completed).not.toHaveProperty("content");
    } finally {
      await agent.shutdown();
    }
  });

  test("routes a permission request after the prompt handler returns", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, permissionRequests, permissionSignals } = createContext();

    try {
      const session = await openSession(agent, context);
      const result = await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "plain prompt" }],
        },
        context,
      );
      expect(result).toEqual({ stopReason: "end_turn" });

      const approval = server.nextApprovalResponse();
      server.requestPermissionAfterPrompt();

      expect(await approval).toEqual(
        expect.objectContaining({
          kind: "approval_response",
          request_id: "approval-request-after-prompt",
          decision: expect.objectContaining({ behavior: "allow" }),
        }),
      );
      expect(permissionRequests).toContainEqual(
        expect.objectContaining({
          sessionId: session.sessionId,
          toolCall: expect.objectContaining({
            title: "Show working directory after prompt",
          }),
        }),
      );
      // Out-of-turn requests carry a deadline the client can observe.
      expect(permissionSignals.at(-1)).toBeInstanceOf(AbortSignal);
    } finally {
      await agent.shutdown();
    }
  });

  test("auto-allows task bookkeeping in ask-before-edits mode", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, permissionRequests } = createContext();

    try {
      const session = await openSession(agent, context);
      await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "plain prompt" }],
        },
        context,
      );
      const approval = server.nextApprovalResponse();
      server.requestPermissionAfterPrompt({
        requestId: "task-update-request",
        toolName: "TaskUpdate",
        toolCallId: "call-task-update",
        input: { taskId: "task_1", status: "completed" },
      });

      expect(await approval).toEqual(
        expect.objectContaining({
          request_id: "task-update-request",
          decision: expect.objectContaining({ behavior: "allow" }),
        }),
      );
      expect(permissionRequests).toEqual([]);
    } finally {
      await agent.shutdown();
    }
  });

  test("aligns editor-tool approvals with session modes and cwd", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, permissionRequests } = createContext();
    const root = await mkdtemp(join(tmpdir(), "letta-acp-editor-permissions-"));
    const workspace = join(root, "repo");
    const inside = join(workspace, "src", "inside.ts");
    const outside = join(root, "outside.ts");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(inside, "inside\n");
    await writeFile(outside, "outside\n");

    try {
      const session = await openSession(agent, context, workspace);
      await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "plain prompt" }],
        },
        context,
      );

      const insideApproval = server.nextApprovalResponse();
      server.requestPermissionAfterPrompt({
        requestId: "read-inside",
        toolName: "read_editor_buffer",
        toolCallId: "call-read-inside",
        input: { path: inside },
      });
      expect(await insideApproval).toMatchObject({
        request_id: "read-inside",
        decision: { behavior: "allow" },
      });
      expect(permissionRequests).toEqual([]);

      const outsideApproval = server.nextApprovalResponse();
      server.requestPermissionAfterPrompt({
        requestId: "read-outside",
        toolName: "read_editor_buffer",
        toolCallId: "call-read-outside",
        input: { path: outside },
      });
      await outsideApproval;
      expect(permissionRequests.at(-1)).toMatchObject({
        toolCall: {
          toolCallId: "call-read-outside",
          kind: "read",
          rawInput: { path: outside },
        },
      });

      const standardWrite = server.nextApprovalResponse();
      server.requestPermissionAfterPrompt({
        requestId: "write-standard",
        toolName: "write_via_editor",
        toolCallId: "call-write-standard",
        input: { path: inside, content: "changed\n" },
      });
      await standardWrite;
      expect(permissionRequests.at(-1)).toMatchObject({
        toolCall: {
          toolCallId: "call-write-standard",
          kind: "edit",
        },
      });

      await agent.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "permissions",
        value: "acceptEdits",
      });
      const requestCount = permissionRequests.length;
      const acceptedWrite = server.nextApprovalResponse();
      server.requestPermissionAfterPrompt({
        requestId: "write-accepted",
        toolName: "write_via_editor",
        toolCallId: "call-write-accepted",
        input: { path: inside, content: "accepted\n" },
      });
      expect(await acceptedWrite).toMatchObject({
        request_id: "write-accepted",
        decision: { behavior: "allow" },
      });
      expect(permissionRequests).toHaveLength(requestCount);
    } finally {
      await agent.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("scopes always-allow editor decisions to one ACP session", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, permissionRequests } = createContext({
      permissionOptionId: "allow_always",
    });
    const root = await mkdtemp(join(tmpdir(), "letta-acp-editor-always-"));
    const firstWorkspace = join(root, "first");
    const secondWorkspace = join(root, "second");
    const outside = join(root, "outside.ts");
    await mkdir(firstWorkspace, { recursive: true });
    await mkdir(secondWorkspace, { recursive: true });
    await writeFile(outside, "outside\n");

    try {
      const first = await openSession(agent, context, firstWorkspace);
      await agent.prompt(
        {
          sessionId: first.sessionId,
          prompt: [{ type: "text", text: "plain prompt" }],
        },
        context,
      );
      for (const requestId of ["first-read", "first-read-again"]) {
        const approval = server.nextApprovalResponse();
        server.requestPermissionAfterPrompt({
          requestId,
          toolName: "read_editor_buffer",
          toolCallId: `call-${requestId}`,
          input: { path: outside },
        });
        await approval;
      }
      expect(permissionRequests).toHaveLength(1);

      const second = await openSession(agent, context, secondWorkspace);
      await agent.prompt(
        {
          sessionId: second.sessionId,
          prompt: [{ type: "text", text: "plain prompt" }],
        },
        context,
      );
      const secondApproval = server.nextApprovalResponse();
      server.requestPermissionAfterPrompt({
        requestId: "second-read",
        toolName: "read_editor_buffer",
        toolCallId: "call-second-read",
        input: { path: outside },
      });
      await secondApproval;
      expect(permissionRequests).toHaveLength(2);
    } finally {
      await agent.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("attaches a permission request to the tool call it belongs to", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, permissionRequests } = createContext();

    try {
      const session = await openSession(agent, context);
      // Leaves a streamed Bash call as the most recent one, so name matching
      // cannot find the Write call the approval is actually for.
      await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "fragmented prompt" }],
        },
        context,
      );

      const approval = server.nextApprovalResponse();
      server.requestPermissionAfterPrompt({
        requestId: "approval-unrelated-tool",
        toolName: "Write",
        toolCallId: "call-write",
        input: { file_path: "/tmp/example.ts" },
      });
      await approval;

      // A synthetic id here would render a permission card the client can
      // never reconcile with the tool call in the stream.
      expect(permissionRequests.at(-1)).toEqual(
        expect.objectContaining({
          toolCall: expect.objectContaining({
            toolCallId: "call-write",
            title: "Write: /tmp/example.ts",
            kind: "edit",
          }),
        }),
      );
    } finally {
      await agent.shutdown();
    }
  });

  test("denies a permission request that lands after cancellation", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, permissionRequests } = createContext();

    try {
      const session = await openSession(agent, context);
      await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "plain prompt" }],
        },
        context,
      );
      await agent.cancel({ sessionId: session.sessionId });

      const approval = server.nextApprovalResponse();
      server.requestPermissionAfterPrompt();

      expect(await approval).toEqual(
        expect.objectContaining({
          request_id: "approval-request-after-prompt",
          decision: expect.objectContaining({
            behavior: "deny",
            message: "Prompt turn was cancelled",
          }),
        }),
      );
      // The user already pressed stop; they should not be asked again.
      expect(permissionRequests).toEqual([]);
    } finally {
      await agent.shutdown();
    }
  });

  test("denies an out-of-turn permission request the client never answers", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server, { outOfTurnPermissionTimeoutMs: 10 });
    const { context, permissionSignals } = createContext({
      answerPermissions: false,
    });

    try {
      const session = await openSession(agent, context);
      await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "plain prompt" }],
        },
        context,
      );

      const approval = server.nextApprovalResponse();
      server.requestPermissionAfterPrompt();

      expect(await approval).toEqual(
        expect.objectContaining({
          request_id: "approval-request-after-prompt",
          decision: expect.objectContaining({
            behavior: "deny",
            message:
              "Permission request timed out after 10ms while trying to " +
              "approve Bash outside a prompt turn",
          }),
        }),
      );
      expect(permissionSignals.at(-1)?.aborted).toBe(true);
    } finally {
      await agent.shutdown();
    }
  });

  test("ends a contradicted turn when the SDK drops the still-running continuation", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, updates } = createContext();

    try {
      const session = await openSession(agent, context);
      const result = await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "busy idle prompt" }],
        },
        context,
      );

      expect(result).toEqual({ stopReason: "end_turn" });
      // SDK 0.8 settles every run id listed on the contradicted idle status.
      // The continuation for that run is dropped before this adapter can see
      // it, so the prompt must end instead of waiting for a second idle.
      expect(updates).not.toContainEqual({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "STILL_WORKING" },
      });
    } finally {
      await agent.shutdown();
    }
  });

  test("ends the turn when a contradicted completion is never followed up", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server, { prematureResultGraceMs: 20 });
    const { context } = createContext();

    try {
      const session = await openSession(agent, context);
      // The status was simply stale: nothing follows it. The grace period has
      // to expire on its own, or the prompt would hang forever.
      const result = await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "silent idle prompt" }],
        },
        context,
      );

      expect(result).toEqual({ stopReason: "end_turn" });
    } finally {
      await agent.shutdown();
    }
  });

  test("recovers a prompt after an approved mutating tool call", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, updates, permissionRequests } = createContext();

    try {
      const session = await openSession(agent, context);
      const result = await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "approval prompt" }],
        },
        context,
      );

      expect(result).toEqual({ stopReason: "end_turn" });
      expect(permissionRequests).toHaveLength(1);
      expect(permissionRequests[0]).toMatchObject({
        sessionId: session.sessionId,
        toolCall: { title: "Write: /tmp/test.txt" },
      });
      expect(server.approvalResponses).toHaveLength(1);
      expect(server.approvalResponses[0]).toMatchObject({
        kind: "approval_response",
        request_id: "approval-request-1",
        decision: { behavior: "allow" },
      });
      expect(updates).toContainEqual(
        expect.objectContaining({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-approval",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "write completed" },
            },
          ],
        }),
      );
      expect(updates).toContainEqual({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "APPROVAL_OK" },
      });
    } finally {
      await agent.shutdown();
    }
  });

  test("recovers an execute command after an approved tool call", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, updates, permissionRequests } = createContext({
      permissionDelayMs: 10,
    });

    try {
      const session = await openSession(agent, context);
      const result = await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "/remember command fact" }],
        },
        context,
      );

      expect(result).toEqual({ stopReason: "end_turn" });
      expect(permissionRequests).toHaveLength(1);
      expect(permissionRequests[0]).toMatchObject({
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "call-command-approval",
          title: "Write: /tmp/command-test.txt",
        },
      });
      expect(updates).toContainEqual({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "COMMAND_APPROVAL_OK" },
      });
    } finally {
      await agent.shutdown();
    }
  });

  test("drains a cancelled turn before starting its replacement", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context, updates } = createContext();

    try {
      const session = await openSession(agent, context);
      const started = server.nextCancelablePrompt();
      const first = agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "cancel active prompt" }],
        },
        context,
      );
      await started;
      await agent.cancel({ sessionId: session.sessionId });
      expect(await first).toEqual({ stopReason: "cancelled" });

      const replacementUpdateStart = updates.length;
      const replacement = await agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "replacement after cancel" }],
        },
        context,
      );

      expect(replacement).toEqual({ stopReason: "end_turn" });
      expect(updates.slice(replacementUpdateStart)).toContainEqual({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "REPLACEMENT_OK" },
      });
    } finally {
      await agent.shutdown();
    }
  });

  test("cancels an execute command before its first turn event", async () => {
    const server = new FakeAppServer();
    const agent = createAgent(server);
    const { context } = createContext();

    try {
      const session = await openSession(agent, context);
      const commandStarted = server.nextCommand();
      const prompt = agent.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "/init" }],
        },
        context,
      );
      await commandStarted;
      await agent.cancel({ sessionId: session.sessionId });

      expect(await prompt).toEqual({ stopReason: "cancelled" });
    } finally {
      await agent.shutdown();
    }
  });
});
