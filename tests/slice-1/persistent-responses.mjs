import { createHash } from "node:crypto";

const tasks = {
  storage: {
    recommendation:
      "For the offline five-person tracker, prefer SQLite with sync when a native client can own the database. Use IndexedDB with sync for a browser-only client. Both need an explicit conflict policy.",
    workers: [
      {
        name: "correctness",
        question:
          "Compare SQLite with sync and IndexedDB with sync for offline correctness, concurrent task edits, and recovery in a five-person task tracker. Return one bounded conclusion.",
        answer:
          "SQLite transactions protect local multi-row edits. IndexedDB transactions protect local object-store edits. Neither provides cross-device consistency alone. Use stable task IDs, a durable outbox, versioned changes, and an explicit conflict rule for concurrent edits.",
      },
      {
        name: "effort",
        question:
          "Compare implementation effort for SQLite with sync and IndexedDB with sync in an offline five-person task tracker. Include packaging, migrations, and sync maintenance. Return one bounded conclusion.",
        answer:
          "SQLite needs native or WebAssembly packaging and schema migrations. IndexedDB fits browser deployment but needs object-store migrations and browser quota handling. For five people, choose the supported client platform first and keep the sync protocol small.",
      },
    ],
  },
  slack: {
    recommendation:
      "For Slack event admission, filter before admission, bind replies to the admitted original thread, and keep delivery state. An accepted post with an unknown response must not be resent automatically.",
    workers: [
      {
        name: "filtering",
        question:
          "Review Slack event filtering and deduplication before durable admission. Cover signed replay, changed payloads, bot messages, and thread identity. Return one bounded conclusion.",
        answer:
          "Verify the signed callback before admission. Ignore bot and unsupported events. Persist an event decision keyed by the full event identity and payload digest. Reuse an identical replay and reject a changed payload under the same identity.",
      },
      {
        name: "delivery",
        question:
          "Review Slack reply authority and uncertain physical posts. Cover the original thread, current access, accepted-before-503, and safe retry policy. Return one bounded conclusion.",
        answer:
          "Use the admitted original channel and thread after current access checks. A 503 can follow an accepted physical post, so retain unknown delivery and do not resend that reply automatically. A distinct authorized event can still receive its own reply.",
      },
    ],
  },
};
const marker = "PERSISTENT_AGENT_FIXTURE";
const commandText = (text) =>
  text.split("\n\nAuthorized source excerpts:\n", 1)[0];
const taskPattern =
  /\b(?<family>storage|slack):(?<suffix>[a-z0-9][a-z0-9-]{0,63})\b/u;
const commandPattern =
  /PERSISTENT_AGENT_FIXTURE\s+(?:(?<action>status|update|cancel|recall|subscribe|unsubscribe)\s+)?(?<family>storage|slack):(?<suffix>[a-z0-9][a-z0-9-]{0,63})\b/u;
const externalPattern =
  /^External event (?<eventId>.+)\. Use return_event if it is unrelated to this work\.\n/u;
const textParts = (message) => {
  if (typeof message?.content === "string") {
    return [message.content];
  }
  return Array.isArray(message?.content)
    ? message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
    : [];
};
const messageText = (message) => textParts(message).join("\n");
const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const identifier = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  value.trim() === value;
const callDigest = (operationId, name, index) =>
  createHash("sha256")
    .update(JSON.stringify({ index, name, operationId }))
    .digest("hex");
const answer = (content) => ({ content, role: "assistant" });
const calls = (operationId, name, values) => ({
  content: null,
  role: "assistant",
  tool_calls: values.map((value, index) => ({
    function: { arguments: JSON.stringify(value), name },
    id: `call_${createHash("sha256").update(JSON.stringify({ operationId, name, index, value })).digest("hex").slice(0, 24)}`,
    type: "function",
  })),
});
const slackInput = (text) => {
  const command = commandText(text);
  if (!command.startsWith("Slack event.\n")) {
    return;
  }
  const input = parseJson(command.slice("Slack event.\n".length));
  return identifier(input?.eventId) && typeof input.content?.text === "string"
    ? input
    : undefined;
};
const joinedResults = (messages) => {
  const pending = new Map();
  const results = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        const args = parseJson(call.function?.arguments);
        if (
          identifier(call.id) &&
          typeof call.function?.name === "string" &&
          args &&
          typeof args === "object"
        ) {
          pending.set(call.id, { args, name: call.function.name });
        }
      }
    }
    const call = message.role === "tool" && pending.get(message.tool_call_id);
    if (call) {
      const text = messageText(message);
      results.push({
        ...call,
        index,
        text,
        value: message.isError ? undefined : parseJson(text),
      });
      pending.delete(message.tool_call_id);
    }
  }
  return results;
};
const validStatus = (status) => {
  switch (status?.kind) {
    case "queued":
    case "accepted":
    case "running": {
      return true;
    }
    case "completed": {
      return identifier(status.reportId);
    }
    case "cancelled": {
      return identifier(status.commandId);
    }
    case "failed": {
      return typeof status.reason === "string" && status.reason.length > 0;
    }
    default: {
      return false;
    }
  }
};
const workRow = (value) =>
  identifier(value?.workId) &&
  validStatus(value.status) &&
  Number.isSafeInteger(value.deadlineAt) &&
  value.deadlineAt > 0;
const snapshot = (value) =>
  workRow(value) && typeof value.canCancel === "boolean";
const sameCase = (text, key) => taskPattern.exec(text ?? "")?.[0] === key;
const workCandidates = (results, key) => {
  const found = new Map();
  for (const result of results) {
    if (
      result.name === "start_team" &&
      snapshot(result.value) &&
      sameCase(result.args.goal, key)
    ) {
      found.set(result.value.workId, result.value);
    }
    if (result.name === "list_work" && Array.isArray(result.value?.items)) {
      for (const item of result.value.items) {
        if (workRow(item) && sameCase(item.goal, key)) {
          found.set(item.workId, item);
        }
      }
    }
    if (
      result.name === "recall_work" &&
      workRow(result.value) &&
      result.value.workId === result.args.workId &&
      sameCase(result.value.goal, key)
    ) {
      found.set(result.value.workId, result.value);
    }
  }
  return [...found.values()];
};
const unavailable = () =>
  answer(
    "The tool result is unavailable or invalid. No successful action is confirmed."
  );
const listing = (value) =>
  Array.isArray(value?.items) &&
  value.items.every((item) => workRow(item) && typeof item.goal === "string") &&
  (value.next === undefined ||
    (typeof value.next === "string" &&
      value.next.length > 0 &&
      value.next.length <= 4096));
const listContinuation = (operationId, current, offered) => {
  const listed = current.filter((result) => result.name === "list_work");
  const last = listed.at(-1);
  const next = last?.value?.next;
  return listing(last?.value) &&
    next !== undefined &&
    offered.has("list_work") &&
    !listed.some((result) => result.args.cursor === next)
    ? calls(operationId, "list_work", [{ cursor: next }])
    : undefined;
};
const subscriptionEvent = ({ input, prompt, latest, key }) => {
  const active = slackInput(prompt);
  const events = input.messages
    .slice(0, latest + 1)
    .filter((message) => message.role === "user")
    .map((message) => slackInput(messageText(message)))
    .filter((event) => event && sameCase(event.content.text, key));
  const ids = [...new Set(events.map((event) => event.eventId))];
  return active?.eventId ?? (ids.length === 1 ? ids[0] : undefined);
};
const reportChunk = (report, status, workId) =>
  identifier(report?.id) &&
  report.key?.workId === workId &&
  (status.kind !== "completed" || status.reportId === report.id) &&
  ((report.kind === "completed" && typeof report.text === "string") ||
    (report.kind === "failed" && typeof report.reason === "string"));
const recallChunk = (result, workId, key) => {
  const { value } = result;
  if (
    !workRow(value) ||
    value.workId !== workId ||
    result.args.workId !== workId ||
    !sameCase(value.goal, key) ||
    !Number.isSafeInteger(value.reportOffset) ||
    value.reportOffset < 0 ||
    value.reportOffset > 16_000 ||
    value.reportOffset !== (result.args.offset ?? 0) ||
    typeof value.reportTruncated !== "boolean"
  ) {
    return false;
  }
  const { report } = value;
  if (report === null) {
    return value.status.kind !== "completed" && !value.reportTruncated;
  }
  return reportChunk(report, value.status, workId);
};
const recallMessage = ({ key, work, args, completed, result, operationId }) => {
  const { value } = result;
  if (
    !completed.every(
      (item, index) =>
        recallChunk(item, work.workId, key) &&
        item.value.reportOffset ===
          (index === 0 ? 0 : completed[index - 1].value.nextReportOffset)
    )
  ) {
    return unavailable();
  }
  if (
    value.reportTruncated &&
    Number.isSafeInteger(value.nextReportOffset) &&
    value.nextReportOffset > value.reportOffset &&
    value.nextReportOffset <= 16_000
  ) {
    return calls(operationId, "recall_work", [
      { ...args, offset: value.nextReportOffset },
    ]);
  }
  if (value.reportTruncated) {
    return unavailable();
  }
  const chunks = completed
    .filter((item) => item.value?.workId === work.workId)
    .map((item) => item.value.report?.text ?? item.value.report?.reason ?? "");
  return answer(
    `Work ${work.workId} is ${value.status.kind}. ${chunks.join(" ")}`
  );
};
const controlReceipt = ({
  action,
  key,
  tail,
  work,
  args,
  completed,
  result,
  operationId,
}) => {
  if (action === "subscribe" || action === "unsubscribe") {
    return result.args.eventId === args.eventId &&
      result.value.eventId === args.eventId &&
      result.value.subscribed === (action === "subscribe")
      ? answer(
          `Work ${work.workId} is ${action === "subscribe" ? "subscribed to" : "unsubscribed from"} the admitted Slack event ${args.eventId}.`
        )
      : unavailable();
  }
  if (action === "recall") {
    return recallMessage({ key, work, args, completed, result, operationId });
  }
  return snapshot(result.value) &&
    (action !== "update" || result.args.text === tail) &&
    (action !== "cancel" || result.value.status.kind === "cancelled")
    ? answer(
        `Work ${work.workId} is ${result.value.status.kind}.${action === "update" ? ` Saved update: ${tail}` : ""}`
      )
    : unavailable();
};
const controlMessage = ({
  action,
  key,
  tail,
  input,
  prompt,
  latest,
  results,
  current,
  offered,
  operationId,
}) => {
  const continuation = listContinuation(operationId, current, offered);
  if (continuation) {
    return continuation;
  }
  const candidates = workCandidates(results, key);
  if (candidates.length !== 1) {
    return current.length === 0 && offered.has("list_work")
      ? calls(operationId, "list_work", [{}])
      : answer(
          "No unique permitted work result matches this task. No action was taken."
        );
  }
  const [work] = candidates;
  const names = {
    status: "get_work",
    update: "message_team",
    cancel: "stop_work",
    recall: "recall_work",
    subscribe: "subscribe_work",
    unsubscribe: "unsubscribe_work",
  };
  const name = names[action];
  const args = { workId: work.workId };
  if (action === "update") {
    if (!tail) {
      return answer("An update needs a constraint for the selected work.");
    }
    args.text = tail;
  }
  if (action === "subscribe" || action === "unsubscribe") {
    const eventId = subscriptionEvent({ input, prompt, latest, key });
    if (!eventId) {
      return answer(
        "A unique admitted Slack event reference is required. No subscription was changed."
      );
    }
    args.eventId = eventId;
  }
  const completed = current.filter((result) => result.name === name);
  const result = completed.at(-1);
  if (!result) {
    return offered.has(name) ? calls(operationId, name, [args]) : unavailable();
  }
  if (
    result.args.workId !== work.workId ||
    result.value?.workId !== work.workId
  ) {
    return unavailable();
  }
  return controlReceipt({
    action,
    key,
    tail,
    work,
    args,
    completed,
    result,
    operationId,
  });
};

const externalMessage = (external, prompt, current, offered, operationId) => {
  const text = prompt.slice(external[0].length);
  if (!text.startsWith(`${marker} unrelated`)) {
    return answer(`Related constraint retained: ${text}`);
  }
  const result = current.find((item) => item.name === "return_event");
  if (result) {
    return result.args.eventId === external.groups.eventId &&
      result.value?.eventId === external.groups.eventId &&
      result.value.returned === true
      ? answer("The unrelated request was returned to the coordinator.")
      : unavailable();
  }
  return offered.has("return_event")
    ? calls(operationId, "return_event", [
        {
          eventId: external.groups.eventId,
          reason: "This request is unrelated to the assigned task.",
        },
      ])
    : unavailable();
};
const listMessage = (current, offered, operationId) => {
  if (current.length === 0) {
    return offered.has("list_work")
      ? calls(operationId, "list_work", [{}])
      : unavailable();
  }
  const continuation = listContinuation(operationId, current, offered);
  if (continuation) {
    return continuation;
  }
  if (
    !current.every(
      (result) => result.name === "list_work" && listing(result.value)
    )
  ) {
    return unavailable();
  }
  return answer(
    `Saved work: ${
      current
        .flatMap((result) => result.value.items)
        .map((item) => `${item.workId} ${item.status.kind} ${item.goal}`)
        .join("; ") || "none on these pages"
    }.`
  );
};
const failedWorkerTexts = new Set([
  "The worker did not complete its answer.",
  "The worker answer is unavailable within the output limit.",
  "(no tool output)",
]);
const usableContribution = (text) =>
  text.length <= 16_000 &&
  text.trim().length > 0 &&
  !failedWorkerTexts.has(text.trim());
const goalMessage = ({ family, key, text, current, offered, operationId }) => {
  const task = tasks[family];
  const worker = task.workers.find((item) =>
    text.includes(`worker:${item.name}.`)
  );
  if (worker) {
    return answer(worker.answer);
  }
  if (offered.has("delegate_worker")) {
    const questions = task.workers.map(
      (item) => `${marker} ${key} worker:${item.name}. ${item.question}`
    );
    if (current.length === 0) {
      return calls(
        operationId,
        "delegate_worker",
        questions.map((question) => ({ text: question }))
      );
    }
    const contributions = questions.map((question) =>
      current.filter(
        (result) =>
          result.name === "delegate_worker" && result.args.text === question
      )
    );
    return contributions.every(
      (items) => items.length === 1 && usableContribution(items[0].text)
    )
      ? answer(
          `${task.recommendation} Worker contributions: ${contributions.map(([result]) => result.text.slice(0, 4000)).join(" ")}`
        )
      : unavailable();
  }
  if (offered.has("start_team")) {
    if (current.length === 0) {
      return calls(operationId, "start_team", [{ goal: text }]);
    }
    const admitted = current.filter(
      (result) =>
        result.name === "start_team" &&
        result.args.goal === text &&
        snapshot(result.value)
    );
    return admitted.length === 1
      ? answer(
          `Work ${admitted[0].value.workId} is ${admitted[0].value.status.kind} for ${key}.`
        )
      : unavailable();
  }
  return unavailable();
};
const realisticMessage = (input, operationId, prompt, latest, offered) => {
  const results = joinedResults(input.messages);
  const current = results.filter((result) => result.index > latest);
  const external = externalPattern.exec(prompt);
  if (external) {
    return externalMessage(external, prompt, current, offered, operationId);
  }
  const text = slackInput(prompt)?.content.text ?? prompt;
  if (!text.startsWith(marker)) {
    return;
  }
  if (text === `${marker} stop`) {
    return answer("Choose the task to cancel. No work was cancelled.");
  }
  if (text === `${marker} list`) {
    return listMessage(current, offered, operationId);
  }
  const command = commandPattern.exec(text);
  if (!command) {
    return answer(
      "The request is ordinary conversation. No team work was started."
    );
  }
  const { action, family, suffix } = command.groups;
  const key = `${family}:${suffix}`;
  if (action) {
    return controlMessage({
      action,
      key,
      tail: text
        .slice(command.index + command[0].length)
        .replace(/^[.\s]+/u, ""),
      input,
      prompt,
      latest,
      results,
      current,
      offered,
      operationId,
    });
  }
  return goalMessage({ family, key, text, current, offered, operationId });
};

const legacyTeamMessage = (input, operationId, purpose) => {
  const latest = input.messages.findLastIndex(
    (message) => message.role === "user"
  );
  const prompt = commandText(messageText(input.messages[latest]));
  if (purpose !== "turn" || !prompt.includes("SLACK_TEAM_FIXTURE")) {
    return;
  }
  const results = input.messages
    .slice(latest + 1)
    .filter((message) => message.role === "tool")
    .map(messageText);
  const offered = new Set(
    (input.tools ?? []).map((tool) => tool.function?.name)
  );
  const legacyCalls = (name, values) => ({
    content: null,
    role: "assistant",
    tool_calls: values.map((value, index) => ({
      function: { arguments: JSON.stringify(value), name },
      id: `call_${callDigest(operationId, name, index).slice(0, 24)}`,
      type: "function",
    })),
  });
  if (offered.has("start_team")) {
    return results.length > 0
      ? {
          content: "SLACK_TEAM_FIXTURE coordinator accepted background work.",
          role: "assistant",
        }
      : legacyCalls("start_team", [
          {
            goal: "SLACK_TEAM_FIXTURE Analyze both worker checks and return a bounded summary.",
          },
        ]);
  }
  if (offered.has("delegate_worker")) {
    return results.length > 0
      ? {
          content: `SLACK_TEAM_FIXTURE lead summary: ${results
            .slice(0, 2)
            .map((text) => text.slice(0, 1000))
            .join(" ")}`,
          role: "assistant",
        }
      : legacyCalls("delegate_worker", [
          { text: "SLACK_TEAM_FIXTURE worker:one. Return one bounded result." },
          { text: "SLACK_TEAM_FIXTURE worker:two. Return one bounded result." },
        ]);
  }
  if (prompt.includes("SLACK_TEAM_FIXTURE worker:one")) {
    return {
      content: "SLACK_TEAM_FIXTURE worker one complete.",
      role: "assistant",
    };
  }
  if (prompt.includes("SLACK_TEAM_FIXTURE worker:two")) {
    return {
      content: "SLACK_TEAM_FIXTURE worker two complete.",
      role: "assistant",
    };
  }
};

export const teamMessage = (input, operationId, purpose) => {
  const latest = input.messages.findLastIndex(
    (message) => message.role === "user"
  );
  const prompt = commandText(messageText(input.messages[latest]));
  if (purpose !== "turn") {
    return;
  }
  if (prompt.startsWith("Internal coordinator event.")) {
    const event = parseJson(prompt.slice(prompt.indexOf("\n") + 1));
    if (typeof event?.content?.text !== "string") {
      return unavailable();
    }
    return answer(
      event.content.text.includes("SLACK_TEAM_FIXTURE")
        ? `SLACK_TEAM_FIXTURE coordinator result: ${event.content.text}`
        : `Team report received. ${event.content.text}`
    );
  }
  const offered = new Set(
    (input.tools ?? []).map((tool) => tool.function?.name)
  );
  return (
    realisticMessage(input, operationId, prompt, latest, offered) ??
    legacyTeamMessage(input, operationId, purpose)
  );
};
