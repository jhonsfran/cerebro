/* oxlint-disable no-await-in-loop -- Each outgoing update must pass current authorization before delivery. */
import { createChannelService } from "@cerebro/channels/service";
import { ChannelError } from "@cerebro/channels/types";
import type { StoredRun } from "@cerebro/runtime/ledger";
import type { RuntimePorts } from "@cerebro/runtime/runtime-ports";
import { SessionAgent as NativeSessionAgent } from "@cerebro/runtime/session-agent";
import type { Connection } from "agents";
import { getCurrentAgent } from "agents";
import type { ChatProtocolEvent } from "agents/chat";
import { MessageType, parseProtocolMessage } from "agents/chat";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { z } from "zod";

import { createChannelOptions } from "./channel-services";
import {
  normalizeChatRequest,
  projectSessionItem,
  reconcileChatHistory,
} from "./chat-protocol";
import { requireChatSession } from "./chat-session";
import type { WorkerEnv } from "./env.server";
import { createRuntimeComposition } from "./runtime-composition";
import { runtimeConfiguration } from "./runtime-services";

const chatIdentitySchema = z.object({
  authSessionId: z.string().min(1),
  conversationId: z.string().min(1),
  userId: z.string().min(1),
});
const chatBodySchema = chatIdentitySchema.extend({
  eventId: z.string().min(1),
  runId: z.string().min(1),
  text: z.string().min(1),
});
type ChatIdentity = z.infer<typeof chatIdentitySchema>;
const settleChatSubmission = async (
  submission: Promise<void>
): Promise<boolean> => {
  try {
    await submission;
    return true;
  } catch {
    return false;
  }
};
const requestIdentity = (request: Request): ChatIdentity =>
  chatIdentitySchema.parse({
    authSessionId: request.headers.get("x-cerebro-chat-auth-session"),
    conversationId: request.headers.get("x-cerebro-chat-conversation"),
    userId: request.headers.get("x-cerebro-chat-user"),
  });
const revokeChatConnection = (connection: Connection, error: unknown): void => {
  const code =
    error instanceof ChannelError && error.status === 401 ? 4401 : 4403;
  connection.close(code, "Conversation access is no longer available.");
};

export class SessionAgent extends NativeSessionAgent {
  private readonly runtimeEnv: WorkerEnv;
  private chatBroadcast = Promise.resolve(true);
  private chatSubmission = Promise.resolve(true);
  constructor(state: DurableObjectState, env: WorkerEnv) {
    super(state, env);
    this.runtimeEnv = env;
    const onConnect = this.onConnect.bind(this);
    this.onConnect = async (connection, context) => {
      const identity = requestIdentity(context.request);
      await this.checkChatAccess(identity);
      connection.setState(identity);
      await this.hydrateChat();
      return await onConnect(connection, context);
    };
    const onRequest = this.onRequest.bind(this);
    this.onRequest = async (request) => {
      if (new URL(request.url).pathname.endsWith("/get-messages")) {
        await this.checkChatAccess(requestIdentity(request));
        await this.hydrateChat();
      }
      return await onRequest(request);
    };
    const onMessage = this.onMessage.bind(this);
    this.onMessage = async (connection, message) => {
      try {
        const identity = chatIdentitySchema.parse(connection.state);
        await this.checkChatAccess(identity);
        const event =
          typeof message === "string" ? parseProtocolMessage(message) : null;
        if (event?.type === "chat-request") {
          const previous = this.chatSubmission;
          const submitted = (async () => {
            await previous;
            await this.submitChatMessage(
              connection,
              event,
              identity,
              onMessage
            );
          })();
          this.chatSubmission = settleChatSubmission(submitted);
          return await submitted;
        }
        if (
          event?.type === "stream-resume-request" ||
          event?.type === "stream-resume-ack"
        ) {
          return await onMessage(connection, message);
        }
        throw new ChannelError(
          422,
          "invalid-input",
          "This chat command is not supported."
        );
      } catch (error) {
        if (
          error instanceof ChannelError &&
          error.status !== 401 &&
          error.status !== 403
        ) {
          const event =
            typeof message === "string" ? parseProtocolMessage(message) : null;
          if (event?.type === "chat-request") {
            connection.send(
              JSON.stringify({
                body: error.message,
                done: true,
                error: true,
                id: event.id,
                type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
              })
            );
            return;
          }
        }
        revokeChatConnection(connection, error);
      }
    };
  }

  private async submitChatMessage(
    connection: Connection,
    event: Extract<ChatProtocolEvent, { type: "chat-request" }>,
    identity: ChatIdentity,
    onMessage: NativeSessionAgent["onMessage"]
  ): Promise<void> {
    await this.checkChatAccess(identity);
    const normalized = normalizeChatRequest(event, this.messages, identity);
    const options = createChannelOptions(this.runtimeEnv);
    const accepted = await options.withDatabase((database) =>
      createChannelService(database, options).submit(
        identity.userId,
        identity.conversationId,
        normalized.body.eventId,
        normalized.body.text
      )
    );
    await this.ctx.storage.put(
      `cerebro-chat-event:${accepted.receipt.runId}`,
      normalized.body.eventId
    );
    return await onMessage(
      connection,
      JSON.stringify({
        id: event.id,
        init: {
          body: JSON.stringify({
            messages: normalized.messages.filter(
              (message) => message.id !== accepted.receipt.acceptedEventId
            ),
            trigger: "submit-message",
            ...normalized.body,
            runId: accepted.receipt.runId,
          }),
          method: "POST",
        },
        type: MessageType.CF_AGENT_USE_CHAT_REQUEST,
      })
    );
  }

  private async checkChatAccess(identity: ChatIdentity): Promise<void> {
    const options = createChannelOptions(this.runtimeEnv);
    await options.withDatabase(async (database) => {
      await requireChatSession(database, identity);
      const access = await createChannelService(database, options).chatAccess(
        identity.userId,
        identity.conversationId
      );
      if (!this.storage().bind(access.address)) {
        throw new ChannelError(
          403,
          "forbidden",
          "The conversation does not match this session."
        );
      }
      for (const run of this.storage().runs()) {
        if (run.dependencies) {
          const result = await options.checkContentDependencies(
            database,
            access.context,
            run.dependencies
          );
          if (result.status !== "ok") {
            throw new ChannelError(
              403,
              "forbidden",
              "Conversation content is no longer available."
            );
          }
        }
      }
    });
  }

  private async hydrateChat(): Promise<void> {
    const address = this.storage().address();
    if (address) {
      const runs = this.storage().runs();
      const storedEvents = new Map(
        await Promise.all(
          runs.map(async (run) => {
            const key = `cerebro-chat-event:${run.runId}`;
            return [key, await this.ctx.storage.get<string>(key)] as const;
          })
        )
      );
      const admittedEvents = new Map<string, string>();
      for (const run of runs) {
        const eventId = storedEvents.get(`cerebro-chat-event:${run.runId}`);
        if (eventId) {
          admittedEvents.set(run.runId, eventId);
        }
      }
      const messages = reconcileChatHistory(
        this.messages,
        runs,
        this.storage()
          .stream()
          .map((item) => projectSessionItem(item, address.conversationId)),
        admittedEvents
      );
      if (JSON.stringify(messages) !== JSON.stringify(this.messages)) {
        await this.persistMessages(messages);
      }
    }
  }

  override broadcast(
    message: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void {
    const previous = this.chatBroadcast;
    const batch = (async () => {
      await previous;
      const excluded = [...(without ?? [])];
      for (const connection of this.getConnections()) {
        try {
          await this.checkChatAccess(
            chatIdentitySchema.parse(connection.state)
          );
        } catch (error) {
          excluded.push(connection.id);
          revokeChatConnection(connection, error);
        }
      }
      super.broadcast(message, excluded);
    })();
    this.chatBroadcast = settleChatSubmission(batch);
    this.ctx.waitUntil(batch);
  }

  override async onChatMessage(
    _onFinish: Parameters<NativeSessionAgent["onChatMessage"]>[0],
    options?: Parameters<NativeSessionAgent["onChatMessage"]>[1]
  ): Promise<Response> {
    const body = chatBodySchema.parse(options?.body);
    const connection: Connection | undefined = getCurrentAgent().connection;
    if (connection) {
      const identity = chatIdentitySchema.parse(connection.state);
      if (
        identity.userId !== body.userId ||
        identity.authSessionId !== body.authSessionId ||
        identity.conversationId !== body.conversationId
      ) {
        throw new Error("The chat request identity is invalid.");
      }
    }
    await this.checkChatAccess(body);
    const run = this.storage()
      .runs()
      .find((value) => value.runId === body.runId);
    if (!run) {
      throw new Error("The chat run was not admitted.");
    }
    const prior = this.messages.find(
      (message) => message.id === `assistant:${run.runId}`
    );
    let emitted =
      prior?.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("") ?? "";
    const signal = options?.abortSignal ?? new AbortController().signal;
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        writer.write({ messageId: `assistant:${run.runId}`, type: "start" });
        writer.write({
          data: {
            cursor: `chat:${body.eventId}`,
            eventId: body.eventId,
            runId: run.runId,
            text: body.text,
            type: "user",
          },
          id: `user:${body.eventId}`,
          type: "data-conversation-item",
        });
        let textId: string = run.runId;
        writer.write({ id: textId, type: "text-start" });
        for await (const update of this.observeChatRun(run.runId, signal)) {
          await this.checkChatAccess(body);
          if (update.textId && update.textId !== textId) {
            writer.write({ id: textId, type: "text-end" });
            ({ textId } = update);
            emitted = "";
            writer.write({ id: textId, type: "text-start" });
          }
          for (const item of update.items) {
            writer.write({
              data: projectSessionItem(item, body.conversationId),
              id: `session:${item.cursor}`,
              type: "data-conversation-item",
            });
          }
          if (
            update.text.startsWith(emitted) &&
            update.text.length > emitted.length
          ) {
            writer.write({
              delta: update.text.slice(emitted.length),
              id: textId,
              type: "text-delta",
            });
            emitted = update.text;
          }
          if (["failed", "unknown-outcome"].includes(update.run.state)) {
            writer.write({
              errorText:
                update.run.state === "failed"
                  ? "The run failed."
                  : "The run ended with an unknown outcome.",
              type: "error",
            });
          }
        }
        writer.write({ id: textId, type: "text-end" });
        writer.write({ type: "finish" });
      },
      onError: () => "The chat response could not be completed.",
      originalMessages: this.messages,
    });
    return createUIMessageStreamResponse({ stream });
  }

  protected override createRuntime(run: StoredRun): Promise<RuntimePorts> {
    return createRuntimeComposition(
      this.runtimeEnv,
      this.ctx.storage,
      this.storage(),
      run
    );
  }
  override async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/ready") {
      runtimeConfiguration(this.runtimeEnv);
      this.storage();
      return Response.json({ ok: true });
    }
    return await super.onRequest(request);
  }
}
