import { Schema } from "effect";

import { authorize, unwrap } from "../../packages/channels/src/security";
import { ChannelError } from "../../packages/channels/src/types";
import type { ChannelOptions } from "../../packages/channels/src/types";
import type { EventAddress } from "../../packages/contracts/src/events";
import { ChatSnapshot } from "../../packages/contracts/src/session-service";
import type {
  ChatApproval,
  ChatClient,
  ChatRequest,
} from "../../packages/contracts/src/session-service";
import type { Database } from "../../packages/db/src/index";
import { createAgentRepository } from "../../packages/db/src/repositories/agents";

export const FIXTURE_SOURCE_ID = "pilot-source";
export const FIXTURE_TOOL_ID = "fixture-read";
export const FIXTURE_MODEL_ID = "fixture-model";

interface FixtureConversation {
  snapshot: ChatSnapshot;
  readonly inputs: Map<string, string>;
}
const conversations = new Map<string, FixtureConversation>();
const opening = new Map<string, Promise<FixtureConversation>>();
const key = (address: EventAddress): string =>
  JSON.stringify([
    address.organizationId,
    address.agentId,
    address.conversationId,
    address.sessionId,
  ]);
export const resetFixtureSessions = (): void => {
  conversations.clear();
  opening.clear();
};
export const fixtureSubmissionCount = (): number =>
  [...conversations.values()].reduce(
    (total, value) => total + value.inputs.size,
    0
  );

const complete = (
  selected: FixtureConversation,
  operationId: string,
  text: string
): void => {
  selected.snapshot = {
    ...selected.snapshot,
    busy: false,
    messages: [
      ...selected.snapshot.messages,
      {
        id: `answer:${operationId}`,
        role: "assistant",
        state: "complete",
        text: `Fixture answer for "${text}". [Local pilot source](/api/product/conversations/${selected.snapshot.address.conversationId}/sources/${FIXTURE_SOURCE_ID})`,
      },
    ],
  };
};
export const createFixtureChatClient = (
  database: Database,
  options: ChannelOptions
): ChatClient => {
  const now = options.now ?? Date.now;
  const access = async (
    request: ChatRequest,
    action: "read" | "execute" | "approve"
  ) => {
    if (request.signal?.aborted) {
      throw new ChannelError(
        503,
        "unavailable",
        "The request was interrupted."
      );
    }
    await authorize(
      database,
      options,
      request.context,
      action,
      "agent",
      request.address.agentId
    );
  };
  const conversation = async (
    request: ChatRequest
  ): Promise<FixtureConversation> => {
    const sessionKey = key(request.address);
    const prior = conversations.get(sessionKey);
    if (prior) {
      return prior;
    }
    const inFlight = opening.get(sessionKey);
    if (inFlight) {
      return await inFlight;
    }
    const create = async (): Promise<FixtureConversation> => {
      const agent = unwrap(
        await createAgentRepository(database).get(
          request.address.organizationId,
          request.address.agentId,
          "latest",
          { deadlineAt: now() + 10_000 }
        )
      );
      const created: FixtureConversation = {
        inputs: new Map(),
        snapshot: {
          address: request.address,
          agentVersion: agent.version,
          approvals: [],
          busy: false,
          messages: [],
        },
      };
      conversations.set(sessionKey, created);
      return created;
    };
    const pending = create();
    opening.set(sessionKey, pending);
    try {
      return await pending;
    } finally {
      opening.delete(sessionKey);
    }
  };
  const service: ChatClient = {
    async decide(request) {
      await access(request, "approve");
      const selected = await conversation(request);
      const approval = selected.snapshot.approvals.find(
        (item) => item.approvalId === request.approvalId
      );
      if (!approval) {
        throw new ChannelError(404, "not-found", "The approval was not found.");
      }
      const state = request.decision === "allow" ? "allowed" : "denied";
      if (approval.state !== "pending") {
        if (approval.state !== state) {
          throw new ChannelError(
            409,
            "already-final",
            "The approval decision is final."
          );
        }
        return { approvalId: approval.approvalId, state: approval.state };
      }
      const decided: ChatApproval = { ...approval, state };
      selected.snapshot = {
        ...selected.snapshot,
        approvals: selected.snapshot.approvals.map((item) =>
          item.approvalId === decided.approvalId ? decided : item
        ),
        busy: false,
      };
      if (state === "allowed") {
        const input = [...selected.inputs].find(
          ([operationId]) => `approval:${operationId}` === request.approvalId
        );
        if (input) {
          complete(selected, input[0], input[1]);
        }
      }
      return { approvalId: decided.approvalId, state: decided.state };
    },
    async observe(request) {
      const snapshot = await service.read(request);
      return new Response(
        `${JSON.stringify({ snapshot, type: "snapshot" })}\n`,
        {
          headers: { "Content-Type": "application/x-ndjson" },
        }
      );
    },
    async read(request) {
      await access(request, "read");
      const selected = await conversation(request);
      if (
        selected.snapshot.messages.some(
          (message) => message.role === "assistant"
        )
      ) {
        await authorize(
          database,
          options,
          request.context,
          "read",
          "memory",
          FIXTURE_SOURCE_ID
        );
        await authorize(
          database,
          options,
          request.context,
          "read",
          "tool",
          FIXTURE_TOOL_ID
        );
      }
      return Schema.decodeUnknownSync(ChatSnapshot)(
        structuredClone(selected.snapshot)
      );
    },
    async send(request) {
      await access(request, "execute");
      const selected = await conversation(request);
      const prior = selected.inputs.get(request.operationId);
      if (prior !== undefined) {
        return {
          accepted: false,
          operationId: request.operationId,
          session: request.address.sessionId,
        };
      }
      selected.inputs.set(request.operationId, request.text);
      selected.snapshot = {
        ...selected.snapshot,
        messages: [
          ...selected.snapshot.messages,
          {
            id: request.operationId,
            role: "user",
            state: "complete",
            text: request.text,
          },
        ],
      };
      if (/\bapproval\b/iu.test(request.text)) {
        const approval: ChatApproval = {
          approvalId: `approval:${request.operationId}`,
          arguments: { query: request.text },
          callId: `call:${request.operationId}`,
          expiresAt: now() + 60_000,
          operationId: `tool:${request.operationId}`,
          state: "pending",
          taskId: `task:${request.operationId}`,
          toolId: FIXTURE_TOOL_ID,
        };
        selected.snapshot = {
          ...selected.snapshot,
          approvals: [...selected.snapshot.approvals, approval],
          busy: true,
        };
      } else {
        complete(selected, request.operationId, request.text);
      }
      return {
        accepted: true,
        operationId: request.operationId,
        session: request.address.sessionId,
      };
    },
    async stop(request) {
      await access(request, "execute");
      const selected = await conversation(request);
      const stopped = selected.snapshot.busy;
      selected.snapshot = {
        ...selected.snapshot,
        approvals: selected.snapshot.approvals.map((approval) =>
          approval.state === "pending"
            ? { ...approval, state: "cancelled" }
            : approval
        ),
        busy: false,
      };
      return { stopped };
    },
  };
  return service;
};
