import type { EventAddress } from "@cerebro/contracts/events";
import type {
  InspectionEvent,
  InspectionWork,
} from "@cerebro/contracts/inspection";
import type { ChatSnapshot } from "@cerebro/contracts/session-service";
import type { WorkId } from "@cerebro/contracts/work";
import { Badge } from "@cerebro/ui/components/badge";
import { Button } from "@cerebro/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@cerebro/ui/components/empty";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@cerebro/ui/components/sheet";
import { useState } from "react";

import { Disclosure } from "./disclosure";
import { ErrorAlert } from "./feedback";
import type { InspectionTeamFrame } from "./inspection-client";
import { completedInspectionSignal, inspectionTime } from "./inspection-client";
import {
  InspectionFacts,
  InspectionNotice,
  InspectionPagination,
  InspectionResultView,
  InspectionText,
} from "./inspection-fields";
import { InspectionRoles } from "./inspection-role";
import type { Conversation } from "./types";
import { useInspection } from "./use-inspection";

const WorkList = ({
  work,
  selected,
  select,
}: {
  work: readonly InspectionWork[];
  selected: WorkId | null;
  select: (value: WorkId) => void;
}) =>
  work.length === 0 ? (
    <p className="text-muted-foreground">No work on this page.</p>
  ) : (
    <ul className="flex flex-col gap-2">
      {work.map((item) => (
        <li key={item.workId} className="min-w-0">
          <Button
            className="h-auto w-full flex-col items-start gap-1 whitespace-normal"
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={selected === item.workId}
            aria-label={`Inspect work ${item.workId}`}
            onClick={() => select(item.workId)}
          >
            <span className="line-clamp-2 text-left break-words">
              {item.goal.text}
            </span>
            {item.goal.truncated ? (
              <span className="text-muted-foreground">Goal truncated.</span>
            ) : null}
            <span className="flex flex-wrap items-center gap-1">
              <Badge variant="outline">{item.status}</Badge>
              {item.reservationHeld ? (
                <Badge variant="secondary">Slot reserved</Badge>
              ) : null}
            </span>
            <span className="text-muted-foreground w-full truncate text-left">
              {item.workId}
            </span>
          </Button>
        </li>
      ))}
    </ul>
  );

const WorkDetails = ({ work }: { work: InspectionWork }) => (
  <>
    <InspectionText content={work.goal} />
    <InspectionFacts
      rows={[
        ["Work", work.workId],
        ["Source status", work.status],
        ["Dispatched", work.dispatched ? "Yes" : "No"],
        ["Slot reservation", work.reservationHeld ? "Held" : "Released"],
        ["Admitted", inspectionTime(work.admittedAt)],
        ["Deadline", inspectionTime(work.deadlineAt)],
      ]}
    />
    {work.subscriptions.length ? (
      <Disclosure summary="Slack subscriptions">
        {work.subscriptions.map((thread) => (
          <p
            className="break-all"
            key={`${thread.workspaceId}:${thread.channelId}:${thread.rootTimestamp}`}
          >
            {thread.workspaceId} · {thread.channelId} · {thread.rootTimestamp}
          </p>
        ))}
      </Disclosure>
    ) : null}
  </>
);

const olderWork = (
  history: readonly InspectionWork[],
  current: readonly InspectionWork[]
) => {
  const known = new Set(current.map((item) => item.workId));
  return history.filter((item) => !known.has(item.workId));
};

const SelectedTeam = ({
  frame,
  inspector,
}: {
  frame: InspectionTeamFrame;
  inspector: ReturnType<typeof useInspection>;
}) => {
  const { team, work } = frame;
  return (
    <section aria-label="Selected work" className="flex min-w-0 flex-col gap-3">
      <h3 className="font-medium">Selected work</h3>
      <WorkDetails work={work} />
      {team.kind === "not-started" ? (
        <p className="text-muted-foreground">
          This work has not started. No private Team cell was opened.
        </p>
      ) : null}
      {team.kind === "unavailable" ? (
        <p className="text-muted-foreground">
          Private Team details are unavailable. Source work remains visible.
        </p>
      ) : null}
      {team.kind === "available" ? (
        <>
          <h3 className="font-medium">Private Team cell</h3>
          <InspectionFacts
            rows={[
              ["Cell", team.cell],
              ["Team phase", team.phase],
              ["Cleanup sealed", team.sealed ? "Yes" : "No"],
              [
                "Model request reservations",
                `${team.requestReservations} / ${team.requestLimit}`,
              ],
              ["Monetary cost", "Unavailable"],
            ]}
          />
          <InspectionRoles
            team={team}
            selected={inspector.role}
            page={
              inspector.role === null ? { kind: "idle" } : inspector.rolePage
            }
            select={inspector.selectRole}
          />
        </>
      ) : null}
      <InspectionResultView
        result={
          team.kind === "available" ? (team.result ?? work.result) : work.result
        }
      />
    </section>
  );
};

const EventDetails = ({ event }: { event: InspectionEvent }) => (
  <article className="flex flex-col gap-2 border p-2">
    <h4 className="font-medium break-all">{event.id}</h4>
    <InspectionFacts
      rows={[
        ["Source", event.source],
        ["Route", event.route],
        ["Duplicates", event.duplicates],
        ["Admission", event.admission],
        ["Outcome", event.outcome],
      ]}
    />
    {event.workIds.map((id) => (
      <p className="break-all" key={id}>
        Work {id}
      </p>
    ))}
    {event.returns.map((item) => (
      <p className="break-all" key={item.workId}>
        Return {item.workId} · {item.decision}
      </p>
    ))}
    {event.reply ? (
      <InspectionFacts
        rows={[
          ["Reply", event.reply.state],
          ["Reply attempts", event.reply.attempts],
          ["Answer entry", event.reply.answerEntryId],
          ["Reply task", event.reply.taskId],
          ["Reply deadline", inspectionTime(event.reply.deadlineAt)],
          ["Reply retry", inspectionTime(event.reply.retryAt)],
          ["Slack timestamp", event.reply.timestamp],
        ]}
      />
    ) : null}
  </article>
);

const SelectedWork = ({
  inspector,
}: {
  inspector: ReturnType<typeof useInspection>;
}) => {
  if (inspector.team.kind === "ready") {
    return <SelectedTeam frame={inspector.team.value} inspector={inspector} />;
  }
  if (inspector.workId === null) {
    return (
      <Empty className="min-h-28 border">
        <EmptyHeader>
          <EmptyTitle>Select work to inspect</EmptyTitle>
          <EmptyDescription>
            Private Team details load when selected.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return <InspectionNotice state={inspector.team} />;
};

const InspectionWorkView = ({
  inspector,
}: {
  inspector: ReturnType<typeof useInspection>;
}) => {
  if (inspector.overview.kind !== "ready") {
    return <InspectionNotice state={inspector.overview} />;
  }
  return (
    <>
      <p className="text-muted-foreground">
        Definition {inspector.overview.value.profile.agentVersion}
      </p>
      <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)]">
        <section
          aria-label="Inspector work"
          className="flex min-w-0 flex-col gap-2"
        >
          <h3 className="font-medium">Active, queued, and recent work</h3>
          <WorkList
            work={inspector.overview.value.work}
            selected={inspector.workId}
            select={inspector.selectWork}
          />
          <Button
            type="button"
            size="xs"
            variant="outline"
            aria-expanded={inspector.historyOpen}
            onClick={() => inspector.showHistory()}
          >
            Work history
          </Button>
          {inspector.historyOpen ? (
            <section aria-label="Work history" className="flex flex-col gap-2">
              <InspectionNotice state={inspector.history} />
              {inspector.history.kind === "ready" ? (
                <>
                  <WorkList
                    work={olderWork(
                      inspector.history.value.work,
                      inspector.overview.value.work
                    )}
                    selected={inspector.workId}
                    select={inspector.selectWork}
                  />
                  <InspectionPagination
                    label="work"
                    next={inspector.history.value.next}
                    latest={() => inspector.showHistory()}
                    older={inspector.showHistory}
                  />
                </>
              ) : null}
            </section>
          ) : null}
        </section>
        <div className="flex min-w-0 flex-col gap-2">
          <SelectedWork inspector={inspector} />
        </div>
      </div>
    </>
  );
};

const InspectionEventView = ({
  inspector,
}: {
  inspector: ReturnType<typeof useInspection>;
}) => (
  <>
    <Button
      type="button"
      size="xs"
      variant="outline"
      className="self-start"
      aria-expanded={inspector.eventsOpen}
      onClick={() => inspector.showEvents()}
    >
      Owned events
    </Button>
    {inspector.eventsOpen ? (
      <section aria-label="Owned events" className="flex flex-col gap-2">
        <InspectionNotice state={inspector.events} />
        {inspector.events.kind === "ready" ? (
          <>
            {inspector.events.value.events.length ? (
              inspector.events.value.events.map((event) => (
                <EventDetails key={event.id} event={event} />
              ))
            ) : (
              <p className="text-muted-foreground">
                No owned events on this page.
              </p>
            )}
            <InspectionPagination
              label="events"
              next={inspector.events.value.next}
              latest={() => inspector.showEvents()}
              older={inspector.showEvents}
            />
          </>
        ) : null}
      </section>
    ) : null}
  </>
);

interface InspectorProps {
  readonly path: string;
  readonly source: EventAddress;
  readonly workSignal: string | null;
  readonly completedSignal: string | null;
}

const InspectorSession = (props: InspectorProps) => {
  const [open, setOpen] = useState(false);
  const inspector = useInspection({ ...props, open });
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        if (!value) {
          inspector.close();
        }
        setOpen(value);
      }}
    >
      <SheetTrigger render={<Button size="sm" variant="ghost" />}>
        Inspector
      </SheetTrigger>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-4xl">
        <SheetHeader className="pr-12">
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle>Inspector</SheetTitle>
            {inspector.denied ? null : (
              <Button
                size="xs"
                variant="outline"
                type="button"
                onClick={() => inspector.refresh()}
              >
                Refresh Inspector
              </Button>
            )}
          </div>
          <SheetDescription>
            Inspect background work, events, and private agent details.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {inspector.denied ? (
            <ErrorAlert>Inspector access is no longer available.</ErrorAlert>
          ) : (
            <div className="flex flex-col gap-3">
              <Disclosure summary="Identity cell and coordinator conversation">
                <InspectionFacts
                  rows={[
                    ["Organization", props.source.organizationId],
                    ["Agent", props.source.agentId],
                    [
                      "Public coordinator conversation",
                      props.source.conversationId,
                    ],
                    ["Public session", props.source.sessionId],
                  ]}
                />
              </Disclosure>
              <InspectionWorkView inspector={inspector} />
              <InspectionEventView inspector={inspector} />
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};

export const ConversationInspector = ({
  path,
  conversation,
  snapshot,
}: {
  readonly path: string;
  readonly conversation: Conversation | null;
  readonly snapshot: Pick<ChatSnapshot, "messages" | "activity">;
}) => {
  if (!conversation) {
    return null;
  }
  return (
    <InspectorSession
      key={JSON.stringify(conversation.snapshot.address)}
      path={path}
      source={conversation.snapshot.address}
      workSignal={snapshot.activity?.backgroundWork?.workId ?? null}
      completedSignal={completedInspectionSignal(snapshot.messages)}
    />
  );
};
