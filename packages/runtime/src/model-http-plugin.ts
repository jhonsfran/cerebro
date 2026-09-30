/* oxlint-disable no-await-in-loop -- Response chunks and journal transitions must preserve transport order. */
import { id } from "@cerebro/contracts/identity";
import type { PortResult } from "@cerebro/contracts/port";
import { digestToolArguments } from "@cerebro/contracts/tools";
import type {
  WorkOutcome,
  PaidWorkRequest,
} from "@cerebro/policy/authorization-gate";
import type { Plugin } from "@opencode-ai/plugin";

import type { StoredRun } from "./ledger.ts";
import type { ModelHttpReceipt, RuntimePorts } from "./runtime-ports.ts";

interface PendingRequest {
  readonly outcome: ReturnType<
    typeof Promise.withResolvers<WorkOutcome<ModelHttpReceipt>>
  >;
  readonly accounted: Promise<PortResult<ModelHttpReceipt>>;
  readonly abort: AbortController;
  readonly deadlineAt: number;
  readonly classifyFailure: (phase: string) => void;
}
const terminalEventPattern = /^data:\s*\[DONE\]$/u;
const boundedText = async (
  response: Response,
  maximum: number,
  signal?: AbortSignal
): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const cancellation = Promise.withResolvers<never>();
  const abort = () =>
    cancellation.reject(new Error("Model transport deadline expired."));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    abort();
  }
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), cancellation.promise]);
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > maximum) {
        throw new Error("Model response exceeds its byte bound.");
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
    bytes
  );
};
const usageFrom = (body: string, contentType: string) => {
  const values: unknown[] = contentType.includes("text/event-stream")
    ? body
        .split(/\r?\n/u)
        .filter(
          (line) =>
            line.startsWith("data:") && line.slice(5).trim() !== "[DONE]"
        )
        .map((line) => JSON.parse(line.slice(5)))
    : [JSON.parse(body)];
  let usage: { input: number; output: number } | undefined;
  for (const value of values) {
    if (
      !value ||
      typeof value !== "object" ||
      !("usage" in value) ||
      !value.usage ||
      typeof value.usage !== "object"
    ) {
      continue;
    }
    const entry = value.usage as Record<string, unknown>;
    const input = entry.prompt_tokens;
    const output = entry.completion_tokens;
    if (
      typeof input === "number" &&
      Number.isSafeInteger(input) &&
      input >= 0 &&
      typeof output === "number" &&
      Number.isSafeInteger(output) &&
      output >= 0
    ) {
      usage = { input, output };
    }
  }
  return usage;
};

const eventStreamDelivery = () => {
  const decoder = new TextDecoder();
  let pending = new Uint8Array();
  let terminal = false;
  const held: Uint8Array[] = [];
  return {
    finish: () => [...held, pending].filter((chunk) => chunk.byteLength > 0),
    receive(chunk: Uint8Array): Uint8Array | undefined {
      if (terminal) {
        held.push(chunk);
        return;
      }
      const bytes = new Uint8Array(pending.byteLength + chunk.byteLength);
      bytes.set(pending);
      bytes.set(chunk, pending.byteLength);
      let start = 0;
      let end = bytes.indexOf(10, start);
      while (end !== -1) {
        const line = decoder.decode(bytes.subarray(start, end)).trim();
        if (terminalEventPattern.test(line)) {
          terminal = true;
          held.push(bytes.subarray(start));
          pending = new Uint8Array();
          return start > 0 ? bytes.subarray(0, start) : undefined;
        }
        start = end + 1;
        end = bytes.indexOf(10, start);
      }
      pending = bytes.subarray(start);
      return start > 0 ? bytes.subarray(0, start) : undefined;
    },
  };
};
export const createModelHttpPlugin = (dependencies: {
  readonly storage: DurableObjectStorage;
  readonly ports: RuntimePorts;
  readonly run: () => StoredRun;
  readonly recorded: (operationId: string, receipt: ModelHttpReceipt) => void;
  readonly failed: (result: PortResult<unknown>, phase?: string) => void;
}): Plugin.Plugin => {
  const pending = new Map<string, PendingRequest>();
  const { model } = dependencies.ports;
  return {
    id: "cerebro-paid-model-http",
    async setup(context) {
      await context.session.hook("context", (event) => {
        event.generation.maxTokens = model.maxOutputTokens;
      });
      await context.session.hook("retry", (event) => {
        event.decision = { retry: false };
      });
      await context.session.hook("http.request", async (event) => {
        const run = dependencies.run();
        if (
          ["completed", "cancelled", "failed", "unknown-outcome"].includes(
            run.state
          )
        ) {
          throw new Error("A terminal run cannot dispatch model work.");
        }
        const [prior] = dependencies.storage.sql
          .exec<{ result: string }>(
            "SELECT result FROM cerebro_operation WHERE id=?",
            `model-active:${run.runId}`
          )
          .toArray();
        if (prior) {
          dependencies.storage.sql.exec(
            "INSERT OR IGNORE INTO cerebro_operation(id,result) VALUES(?,?)",
            `model-consumed:${prior.result}`,
            "true"
          );
        }

        const permitted = await dependencies.ports.checkDependencies(
          run,
          run.dependencies ?? { sourceIds: [], toolIds: [] },
          { deadlineAt: Date.now() + model.deadlineMs }
        );
        if (permitted.status !== "ok") {
          dependencies.failed(permitted);
          throw new Error(`Model authorization returned ${permitted.status}.`);
        }
        const base = new URL(model.baseUrl);
        const url = new URL(event.request.url);
        if (
          event.request.method !== "POST" ||
          url.origin !== base.origin ||
          url.pathname !==
            `${base.pathname.replace(/\/$/u, "")}/chat/completions`
        ) {
          throw new Error("Model transport destination is not registered.");
        }
        const text = await boundedText(
          new Response(event.request.clone().body),
          model.maxInputBytes
        );
        const input: unknown = JSON.parse(text);
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw new Error("Model request must contain a JSON object.");
        }
        const body = input as Record<string, unknown>;
        if (body.model !== model.model) {
          throw new Error("Model transport selected another model.");
        }
        body.max_tokens = model.maxOutputTokens;
        delete body.max_completion_tokens;
        if (body.stream === true) {
          body.stream_options = { include_usage: true };
        }
        const boundedBody = JSON.stringify(body);
        if (
          new TextEncoder().encode(boundedBody).byteLength > model.maxInputBytes
        ) {
          throw new Error("Model request exceeds its byte bound.");
        }
        const ordinal = dependencies.storage.transactionSync(() => {
          const key = `model-sequence:${run.runId}`;
          const [row] = dependencies.storage.sql
            .exec<{ result: string }>(
              "SELECT result FROM cerebro_operation WHERE id=?",
              key
            )
            .toArray();
          const next = Number(row?.result ?? "0") + 1;
          if (!Number.isSafeInteger(next) || next > model.maxRequestsPerRun) {
            dependencies.failed({
              reason: "The model request limit for this run is exhausted.",
              status: "invalid-input",
            });
            throw new TypeError("Model request sequence is exhausted.");
          }
          dependencies.storage.sql.exec(
            "INSERT INTO cerebro_operation(id,result) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET result=excluded.result",
            key,
            String(next)
          );
          return next;
        });
        const operationId = id.operation(`${run.operationId}:model:${ordinal}`);
        const request: PaidWorkRequest = {
          action: "execute",
          context: run.context,
          entitlement: {
            agentId: run.agent.agentId,
            capability: "model.request",
            model: model.id,
            organizationId: run.agent.organizationId,
          },
          input: {
            body: boundedBody,
            model: model.id,
            ordinal,
            pricingVersion: model.pricing.version,
            runId: run.runId,
          },
          maximum: {
            unit: model.pricing.unit,
            units:
              model.maxInputBytes * model.pricing.inputPerToken +
              model.maxOutputTokens * model.pricing.outputPerToken,
          },
          resource: {
            id: run.agent.agentId,
            kind: "agent",
            organizationId: run.agent.organizationId,
          },
        };
        const options = {
          deadlineAt: Date.now() + model.deadlineMs,
          operationId,
          requestDigest: await digestToolArguments(request),
        };
        let dispatched = false;
        const gate = Promise.withResolvers<null>();
        const outcome = Promise.withResolvers<WorkOutcome<ModelHttpReceipt>>();
        const abort = new AbortController();
        let failurePhase: string | undefined;
        const timer = setTimeout(() => {
          failurePhase ??= "deadline";
          abort.abort(new Error("Model transport deadline expired."));
          outcome.resolve({
            result: {
              operationId,
              reason: "The model response did not produce a durable receipt.",
              status: "unknown-outcome",
            },
            usage: { state: "unknown" },
          });
        }, model.deadlineMs);
        const accounted = (async (): Promise<PortResult<ModelHttpReceipt>> => {
          let result: PortResult<ModelHttpReceipt>;
          try {
            result = await dependencies.ports.paidModel.run(
              request,
              options,
              async () => {
                dispatched = true;
                dependencies.storage.sql.exec(
                  "INSERT INTO cerebro_operation(id,result) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET result=excluded.result",
                  `model-active:${run.runId}`,
                  operationId
                );
                await dependencies.storage.sync();
                gate.resolve(null);
                return await outcome.promise;
              }
            );
          } catch {
            result = {
              operationId,
              reason: "The model admission or accounting dependency failed.",
              status: "unknown-outcome",
            };
          }
          clearTimeout(timer);
          if (!dispatched && result.status === "ok") {
            gate.reject(
              new Error(
                "A saved model receipt cannot be dispatched again through the SDK transport."
              )
            );
          }
          if (result.status !== "ok") {
            dependencies.failed(result, failurePhase);
            gate.reject(
              new Error(`Paid model request returned ${result.status}.`)
            );
          }
          return result;
        })();
        pending.set(operationId, {
          abort,
          accounted,
          classifyFailure: (phase) => {
            failurePhase ??= phase;
          },
          deadlineAt: options.deadlineAt,
          outcome,
        });
        try {
          await gate.promise;
        } catch (error) {
          pending.delete(operationId);
          throw error;
        }
        const headers = new Headers(event.request.headers);
        headers.set("X-Cerebro-Model-Operation", operationId);
        event.request = new Request(event.request, {
          body: boundedBody,
          headers,
          method: "POST",
          signal: abort.signal,
        });
      });
      await context.session.hook("http.response", (event) => {
        const operationId = event.request.headers.get(
          "X-Cerebro-Model-Operation"
        );
        const work = operationId ? pending.get(operationId) : undefined;
        if (!operationId || !work) {
          throw new Error("Model response has no paid request occurrence.");
        }
        const { response } = event;
        const contentType =
          response.headers.get("Content-Type") ?? "application/json";
        const sse = contentType.includes("text/event-stream")
          ? eventStreamDelivery()
          : undefined;
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        let state: "reading" | "accounting" | "closed" = "reading";
        let phase = "provider-read";
        let failure: Promise<void> | undefined;
        let abortCleanup: Promise<void> | undefined;
        let controller: ReadableStreamDefaultController<Uint8Array>;
        const delivery = {
          cleanup() {
            work.abort.signal.removeEventListener("abort", delivery.onAbort);
            reader?.releaseLock();
            pending.delete(operationId);
            state = "closed";
          },
          complete(current: ReadableStreamDefaultController<Uint8Array>) {
            if (state === "accounting") {
              for (const held of sse?.finish() ?? []) {
                current.enqueue(held);
              }
              current.close();
            }
            delivery.cleanup();
          },
          fail(error: unknown): Promise<void> {
            failure ??= (async () => {
              work.classifyFailure(phase);
              work.outcome.resolve({
                result: {
                  operationId: id.operation(operationId),
                  reason: `The provider response failed during ${phase}.`,
                  status: "unknown-outcome",
                },
                usage: { state: "unknown" },
              });
              try {
                await reader?.cancel(error);
              } catch {
                work.abort.abort(error);
              } finally {
                await work.accounted;
                delivery.cleanup();
              }
            })();
            return failure;
          },
          onAbort() {
            if (state !== "reading") {
              return;
            }
            const error = work.abort.signal.reason;
            state = "closed";
            controller.error(error);
            abortCleanup = delivery.fail(error);
          },
        };
        const stream = new ReadableStream<Uint8Array>(
          {
            async cancel(reason) {
              phase = "consumer-cancellation";
              state = "closed";
              await delivery.fail(reason);
            },
            async pull(current) {
              try {
                for (;;) {
                  phase = "provider-read";
                  const chunk = await reader?.read();
                  if (state !== "reading") {
                    await abortCleanup;
                    return;
                  }
                  if (chunk && !chunk.done) {
                    phase = "response-byte-bound";
                    size += chunk.value.byteLength;
                    if (size > model.maxResponseBytes) {
                      throw new Error("Model response exceeds its byte bound.");
                    }
                    const run = dependencies.run();
                    phase = "content-authorization";
                    const allowed = await dependencies.ports.checkDependencies(
                      run,
                      run.dependencies ?? { sourceIds: [], toolIds: [] },
                      {
                        deadlineAt: work.deadlineAt,
                        signal: work.abort.signal,
                      }
                    );
                    if (state !== "reading") {
                      await abortCleanup;
                      return;
                    }
                    if (allowed.status !== "ok") {
                      throw new Error(
                        `Model stream authorization returned ${allowed.status}.`
                      );
                    }
                    chunks.push(chunk.value);
                    const delivered = sse
                      ? sse.receive(chunk.value)
                      : chunk.value;
                    if (delivered) {
                      current.enqueue(delivered);
                      return;
                    }
                    continue;
                  }
                  phase = "usage-validation";
                  const bytes = new Uint8Array(size);
                  let offset = 0;
                  for (const received of chunks) {
                    bytes.set(received, offset);
                    offset += received.byteLength;
                  }
                  const body = new TextDecoder("utf-8", {
                    fatal: true,
                    ignoreBOM: false,
                  }).decode(bytes);
                  const usage = usageFrom(body, contentType);
                  if (
                    !usage ||
                    usage.input > model.maxInputBytes ||
                    usage.output > model.maxOutputTokens
                  ) {
                    throw new Error(
                      "Model response has no bounded authoritative usage."
                    );
                  }
                  state = "accounting";
                  const units =
                    usage.input * model.pricing.inputPerToken +
                    usage.output * model.pricing.outputPerToken;
                  const receipt: ModelHttpReceipt = {
                    body,
                    headers: { "Content-Type": contentType },
                    inputTokens: usage.input,
                    outputTokens: usage.output,
                    status: response.status,
                    unit: model.pricing.unit,
                    units,
                  };
                  work.outcome.resolve({
                    result: { status: "ok", value: receipt },
                    usage: {
                      incurred: { unit: model.pricing.unit, units },
                      state: "known",
                    },
                  });
                  phase = "accounting";
                  const result = await work.accounted;
                  if (result.status !== "ok") {
                    throw new Error(
                      `Model accounting returned ${result.status}.`
                    );
                  }
                  phase = "receipt-persistence";
                  dependencies.recorded(operationId, result.value);
                  await dependencies.storage.sync();
                  delivery.complete(current);
                  return;
                }
              } catch (error) {
                if (state !== "closed") {
                  state = "closed";
                  current.error(error);
                }
                await delivery.fail(error);
              }
            },
            start(current) {
              controller = current;
              work.abort.signal.addEventListener("abort", delivery.onAbort, {
                once: true,
              });
              if (work.abort.signal.aborted) {
                delivery.onAbort();
              }
            },
          },
          { highWaterMark: 0 }
        );
        event.response = new Response(stream, {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        });
      });
      return async () => {
        for (const [operationId, work] of pending) {
          work.classifyFailure("transport-teardown");
          work.abort.abort(
            new Error("Model transport closed before its receipt.")
          );
          work.outcome.resolve({
            result: {
              operationId: id.operation(operationId),
              reason: "Model transport closed before its receipt.",
              status: "unknown-outcome",
            },
            usage: { state: "unknown" },
          });
          await work.accounted;
        }
        pending.clear();
      };
    },
  };
};
