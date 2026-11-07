import type {
  InspectionRole,
  InspectionTeam,
  InspectionTokens,
} from "@cerebro/contracts/inspection";
import { Badge } from "@cerebro/ui/components/badge";
import { Bubble, BubbleContent } from "@cerebro/ui/components/bubble";
import { Button } from "@cerebro/ui/components/button";
import { Message, MessageContent } from "@cerebro/ui/components/message";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@cerebro/ui/components/message-scroller";

import { Disclosure } from "./disclosure";
import { inspectionTime } from "./inspection-client";
import type {
  InspectionRolePage,
  InspectionTasks,
  InspectionTranscript,
} from "./inspection-client";
import {
  InspectionFacts,
  InspectionNotice,
  InspectionPagination,
  InspectionText,
} from "./inspection-fields";
import type { InspectionLoad, InspectionRoleSelection } from "./use-inspection";

const roleLabel = (role: Pick<InspectionRole, "role" | "slot">): string =>
  role.role === "lead" ? "Lead" : `Worker ${role.slot}`;
const TokenUsage = ({ usage }: { usage: InspectionTokens }) => (
  <InspectionFacts
    rows={[
      ["Input tokens", usage.input],
      ["Output tokens", usage.output],
      ["Cache read tokens", usage.cacheRead],
      ["Cache write tokens", usage.cacheWrite],
      ["Total tokens", usage.totalTokens],
    ]}
  />
);

const RoleSummary = ({
  role,
  select,
  selected,
}: {
  role: InspectionRole;
  select: (value: InspectionRoleSelection) => void;
  selected: InspectionRoleSelection | null;
}) => (
  <article
    aria-label={`${roleLabel(role)} conversation`}
    className="flex flex-col gap-2 border p-3"
  >
    <h4 className="flex flex-wrap items-center gap-2 font-medium">
      {roleLabel(role)} conversation
      <Badge variant={role.running ? "secondary" : "outline"}>
        {role.running ? "Running" : "Idle"}
      </Badge>
    </h4>
    <InspectionFacts
      rows={[
        ["Native conversation", role.nativeId],
        ["Saved model", role.modelId ?? "Not recorded"],
        ["Agent", role.definition.agentId],
        ["Definition version", role.definition.agentVersion],
        ["Owner task", role.ownerTaskId],
        ["Request", role.requestId],
        ["Attempt", role.attempt],
        ["Retry", inspectionTime(role.retryAt)],
      ]}
    />
    <Disclosure summary={`${roleLabel(role)} token usage`}>
      <h5 className="font-medium">Model usage</h5>
      <TokenUsage usage={role.usage} />
      <h5 className="font-medium">Tool usage</h5>
      <TokenUsage usage={role.toolUsage} />
    </Disclosure>
    <div className="flex flex-wrap gap-2">
      {(["transcript", "tools", "tasks"] as const).map((section) => (
        <Button
          key={section}
          type="button"
          size="xs"
          variant="outline"
          aria-pressed={
            selected?.role === role.slot && selected.section === section
          }
          onClick={() => select({ role: role.slot, section })}
        >
          {roleLabel(role)}{" "}
          {section === "tasks" ? "tasks and retries" : section}
        </Button>
      ))}
    </div>
  </article>
);

const Transcript = ({ frame }: { frame: InspectionTranscript }) => (
  <section
    aria-label="Private role transcript"
    className="flex min-h-0 flex-col gap-2"
  >
    {frame.messages.length === 0 ? (
      <p className="text-muted-foreground">No messages on this page.</p>
    ) : (
      <MessageScrollerProvider>
        <MessageScroller className="h-56 min-h-0">
          <MessageScrollerViewport>
            <MessageScrollerContent className="gap-3 p-2">
              {frame.messages.map((message) => (
                <MessageScrollerItem key={message.id} messageId={message.id}>
                  <Message align={message.role === "user" ? "end" : "start"}>
                    <MessageContent>
                      <p className="text-muted-foreground">
                        {message.role} · {message.state} ·{" "}
                        {inspectionTime(message.timestamp)}
                      </p>
                      <Bubble variant="outline">
                        <BubbleContent>
                          <InspectionText content={message.content} />
                        </BubbleContent>
                      </Bubble>
                      <p className="text-muted-foreground break-all">
                        Entry {message.entryId} · Model{" "}
                        {message.modelId ?? "Not recorded"}
                      </p>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
    )}
  </section>
);

const Tools = ({ frame }: { frame: InspectionTranscript }) => (
  <section aria-label="Private role tools" className="flex flex-col gap-2">
    {frame.tools.length === 0 ? (
      <p className="text-muted-foreground">No tools on this page.</p>
    ) : (
      frame.tools.map((tool) => (
        <article
          key={tool.id}
          className="flex flex-col gap-2 border p-2"
          aria-label={`${tool.name} ${tool.status}`}
        >
          <h5 className="flex items-center gap-2 font-medium">
            {tool.name}
            <Badge variant="outline">{tool.status}</Badge>
          </h5>
          {tool.input.kind === "text" ? (
            <div>
              <p className="text-muted-foreground">{tool.input.label}</p>
              <InspectionText content={tool.input.content} />
            </div>
          ) : (
            <p>Input unavailable.</p>
          )}
          {tool.output ? (
            <div>
              <p className="text-muted-foreground">Output</p>
              <InspectionText content={tool.output} />
            </div>
          ) : (
            <p className="text-muted-foreground">
              Output unavailable on this page.
            </p>
          )}
          <InspectionFacts
            rows={[
              ["Tool call", tool.callId],
              ["Result entry", tool.resultEntryId],
            ]}
          />
        </article>
      ))
    )}
  </section>
);

const Tasks = ({ frame }: { frame: InspectionTasks }) => (
  <section
    aria-label="Private role tasks and retries"
    className="flex flex-col gap-2"
  >
    {frame.tasks.length === 0 ? (
      <p className="text-muted-foreground">No tasks on this page.</p>
    ) : (
      frame.tasks.map((task) => (
        <article key={task.id} className="flex flex-col gap-2 border p-2">
          <h5 className="flex flex-wrap items-center gap-2 font-medium">
            {task.kind}
            <Badge variant="outline">{task.status}</Badge>
          </h5>
          <InspectionFacts
            rows={[
              ["Task", task.id],
              ["Definition version", task.version],
              ["Owner task", task.ownerTaskId],
              ["Background", task.background ? "Yes" : "No"],
              ["Abort requested", task.abortRequested ? "Yes" : "No"],
              ["Outcome", task.outcome],
              ["Phase", task.phase],
              ["Attempt", task.attempt],
              ["Retry", inspectionTime(task.retryAt)],
              ["Started", inspectionTime(task.startedAt)],
              ["Ended", inspectionTime(task.endedAt)],
            ]}
          />
        </article>
      ))
    )}
  </section>
);

const RolePage = ({
  frame,
  section,
}: {
  frame: InspectionRolePage;
  section: InspectionRoleSelection["section"];
}) => {
  if (frame.kind === "tasks") {
    return <Tasks frame={frame} />;
  }
  return section === "tools" ? (
    <Tools frame={frame} />
  ) : (
    <Transcript frame={frame} />
  );
};

export const InspectionRoles = ({
  team,
  selected,
  page,
  select,
}: {
  team: Extract<InspectionTeam, { kind: "available" }>;
  selected: InspectionRoleSelection | null;
  page: InspectionLoad<InspectionRolePage>;
  select: (value: InspectionRoleSelection) => void;
}) => {
  const selectedRole = selected
    ? team.roles.find((role) => role.slot === selected.role)
    : undefined;
  return (
    <section aria-label="Team conversations" className="flex flex-col gap-3">
      {team.roles.length === 0 ? (
        <p className="text-muted-foreground">
          No role conversations have started.
        </p>
      ) : (
        team.roles.map((role) => (
          <RoleSummary
            key={role.slot}
            role={role}
            selected={selected}
            select={select}
          />
        ))
      )}
      {selected && selectedRole ? (
        <section
          aria-label={`${roleLabel(selectedRole)} details`}
          className="flex min-h-0 flex-col gap-2"
        >
          <h4 className="font-medium">
            {roleLabel(selectedRole)} ·{" "}
            {selected.section === "tasks"
              ? "Tasks and retries"
              : selected.section}
          </h4>
          <InspectionNotice state={page} />
          {page.kind === "ready" ? (
            <>
              <RolePage frame={page.value} section={selected.section} />
              <InspectionPagination
                next={page.value.next}
                label="role entries"
                latest={() =>
                  select({ role: selected.role, section: selected.section })
                }
                older={(cursor) => select({ ...selected, cursor })}
              />
            </>
          ) : null}
        </section>
      ) : null}
    </section>
  );
};
