import type { EventAddress } from "@cerebro/contracts/events";
import type {
  InspectionQuery,
  InspectionRole,
} from "@cerebro/contracts/inspection";
import type { WorkId } from "@cerebro/contracts/work";
import { useCallback, useEffect, useRef, useState } from "react";

import { currentAccessGeneration } from "./api";
import { readInspection } from "./inspection-client";
import type {
  InspectionEvents,
  InspectionHistory,
  InspectionOverview,
  InspectionRolePage,
  InspectionTeamFrame,
} from "./inspection-client";

export const INSPECTION_REFRESH_MS = 2000;
export type InspectionLoad<Value> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; value: Value };
export interface InspectionRoleSelection {
  readonly role: InspectionRole["slot"];
  readonly section: "transcript" | "tools" | "tasks";
  readonly cursor?: string;
}
interface InspectionData {
  overview: InspectionLoad<InspectionOverview>;
  team: InspectionLoad<InspectionTeamFrame>;
  rolePage: InspectionLoad<InspectionRolePage>;
  history: InspectionLoad<InspectionHistory>;
  events: InspectionLoad<InspectionEvents>;
}
const emptyData = (): InspectionData => ({
  overview: { kind: "idle" },
  team: { kind: "idle" },
  rolePage: { kind: "idle" },
  history: { kind: "idle" },
  events: { kind: "idle" },
});
type PageQuery = Extract<InspectionQuery, { kind: "history" | "events" }>;
interface RefreshRequest {
  readonly revision: number;
  readonly kind: "manual" | "poll";
}

export const useInspection = ({
  path,
  source,
  open,
  workSignal,
  completedSignal,
}: {
  readonly path: string;
  readonly source: EventAddress;
  readonly open: boolean;
  readonly workSignal: string | null;
  readonly completedSignal: string | null;
}) => {
  const [data, setData] = useState(emptyData);
  const saved = useRef(data);
  const [workId, setWorkId] = useState<WorkId | null>(null);
  const [role, setRole] = useState<InspectionRoleSelection | null>(null);
  const [historyQuery, setHistoryQuery] = useState<
    (PageQuery & { kind: "history" }) | null
  >(null);
  const [eventsQuery, setEventsQuery] = useState<
    (PageQuery & { kind: "events" }) | null
  >(null);
  const [refreshRequest, setRefreshRequest] = useState<RefreshRequest>({
    revision: 0,
    kind: "manual",
  });
  const [nextRefresh, setNextRefresh] = useState<number | null>(null);
  const cycles = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [denied, setDenied] = useState(false);
  const active = useRef<{
    readonly controller: AbortController;
    readonly stop: () => void;
  } | null>(null);
  const loaded = useRef({ overviewCause: "", revision: -1 });
  const refreshState = useRef({ source: false, team: false });
  const update = useCallback(
    <Key extends keyof InspectionData>(
      key: Key,
      value: InspectionData[Key]
    ) => {
      saved.current = { ...saved.current, [key]: value };
      setData(saved.current);
    },
    []
  );
  const cancel = useCallback(() => {
    active.current?.stop();
    clearTimeout(timer.current ?? undefined);
    timer.current = null;
    setNextRefresh(null);
  }, []);
  const clear = useCallback(() => {
    cancel();
    saved.current = emptyData();
    setData(saved.current);
    setWorkId(null);
    setRole(null);
    setHistoryQuery(null);
    setEventsQuery(null);
    loaded.current = { overviewCause: "", revision: -1 };
    refreshState.current = { source: false, team: false };
  }, [cancel]);

  useEffect(() => {
    const onDenied = () => {
      clear();
      setDenied(true);
    };
    window.addEventListener("cerebro:access-cleared", onDenied);
    return () => window.removeEventListener("cerebro:access-cleared", onDenied);
  }, [clear]);

  const { organizationId, agentId, conversationId, sessionId } = source;
  const roleSlot = role?.role;
  const roleKind = role?.section === "tasks" ? "tasks" : "transcript";
  const roleCursor = role?.cursor;
  const historyOpen = historyQuery !== null;
  const historyCursor = historyQuery?.cursor;
  const eventsOpen = eventsQuery !== null;
  const eventsCursor = eventsQuery?.cursor;

  useEffect(() => {
    if (!open || denied) {
      return;
    }
    cycles.current += 1;
    const cycleId = cycles.current;
    clearTimeout(timer.current ?? undefined);
    timer.current = null;
    const controller = new AbortController();
    const stop = () => {
      controller.abort();
      if (active.current?.controller === controller) {
        active.current = null;
        clearTimeout(timer.current ?? undefined);
        timer.current = null;
      }
    };
    active.current = { controller, stop };
    const generation = currentAccessGeneration();
    const address = { organizationId, agentId, conversationId, sessionId };
    const live = () =>
      active.current?.controller === controller &&
      !controller.signal.aborted &&
      generation === currentAccessGeneration();
    const get = (query: InspectionQuery) =>
      readInspection(path, address, query, controller.signal);
    const cause = JSON.stringify([
      workSignal,
      completedSignal,
      refreshRequest.revision,
    ]);
    const requested = loaded.current.revision !== refreshRequest.revision;
    const manual = requested && refreshRequest.kind === "manual";
    const poll = requested && refreshRequest.kind === "poll";
    loaded.current.revision = refreshRequest.revision;
    const load = async <Key extends keyof InspectionData>(
      key: Key,
      read: () => Promise<InspectionData[Key]>
    ) => {
      if (saved.current[key].kind !== "ready") {
        update(key, { kind: "loading" });
      }
      try {
        const value = await read();
        if (live()) {
          update(key, value);
        }
      } catch {
        if (live()) {
          update(key, { kind: "failed" });
        }
      }
    };
    const selectedTeam = () => {
      const { team } = saved.current;
      return team.kind === "ready" && team.value.work.workId === workId
        ? team.value.team
        : null;
    };
    const previousTeam = selectedTeam();
    const refreshDetails =
      manual ||
      (poll && !(previousTeam?.kind === "available" && previousTeam.sealed));
    const loadOverview = async () => {
      if (
        !poll &&
        loaded.current.overviewCause === cause &&
        saved.current.overview.kind === "ready"
      ) {
        return;
      }
      await load("overview", async () => {
        const frame = await get({ kind: "overview" });
        if (frame.kind !== "overview") {
          throw new Error("Invalid overview.");
        }
        if (live()) {
          loaded.current.overviewCause = cause;
          refreshState.current.source = frame.refresh;
        }
        return { kind: "ready", value: frame };
      });
    };
    const loadTeam = async () => {
      if (!workId) {
        return;
      }
      if (previousTeam && !refreshDetails) {
        return;
      }
      await load("team", async () => {
        const frame = await get({ kind: "team", workId });
        if (frame.kind !== "team") {
          throw new Error("Invalid Team.");
        }
        if (live()) {
          refreshState.current.team =
            frame.team.kind === "available" && !frame.team.sealed;
        }
        return { kind: "ready", value: frame };
      });
    };
    const loadHistory = async () => {
      if (
        !historyOpen ||
        (saved.current.history.kind === "ready" && !(manual && !poll))
      ) {
        return;
      }
      await load("history", async () => {
        const frame = await get({
          kind: "history",
          ...(historyCursor ? { cursor: historyCursor } : {}),
        });
        if (frame.kind !== "history") {
          throw new Error("Invalid history.");
        }
        return { kind: "ready", value: frame };
      });
    };
    const loadEvents = async () => {
      if (
        !eventsOpen ||
        (saved.current.events.kind === "ready" && !poll && !manual)
      ) {
        return;
      }
      await load("events", async () => {
        const frame = await get({
          kind: "events",
          ...(eventsCursor ? { cursor: eventsCursor } : {}),
        });
        if (frame.kind !== "events") {
          throw new Error("Invalid events.");
        }
        return { kind: "ready", value: frame };
      });
    };
    const loadRole = async () => {
      const team = selectedTeam();
      if (
        !workId ||
        roleSlot === undefined ||
        team?.kind !== "available" ||
        !team.roles.some((item) => item.slot === roleSlot)
      ) {
        return;
      }
      if (saved.current.rolePage.kind === "ready" && !refreshDetails) {
        return;
      }
      await load("rolePage", async () => {
        const frame = await get({
          kind: roleKind,
          workId,
          role: roleSlot,
          ...(roleCursor ? { cursor: roleCursor } : {}),
        });
        if (frame.kind !== "tasks" && frame.kind !== "transcript") {
          throw new Error("Invalid role page.");
        }
        return { kind: "ready", value: frame };
      });
    };
    const needsRefresh = () =>
      refreshState.current.source || refreshState.current.team;
    const cycle = async () => {
      await Promise.all([
        loadOverview(),
        loadTeam(),
        loadHistory(),
        loadEvents(),
      ]);
      if (!live()) {
        return;
      }
      await loadRole();
      if (live() && needsRefresh()) {
        setNextRefresh(cycleId);
      }
    };
    void cycle();
    return stop;
  }, [
    path,
    organizationId,
    agentId,
    conversationId,
    sessionId,
    open,
    denied,
    workId,
    roleSlot,
    roleKind,
    roleCursor,
    historyOpen,
    historyCursor,
    eventsOpen,
    eventsCursor,
    refreshRequest,
    workSignal,
    completedSignal,
    update,
  ]);

  useEffect(() => {
    if (
      !open ||
      denied ||
      nextRefresh === null ||
      nextRefresh !== cycles.current
    ) {
      return;
    }
    const handle = setTimeout(() => {
      setRefreshRequest((current) => ({
        revision: current.revision + 1,
        kind: "poll",
      }));
    }, INSPECTION_REFRESH_MS);
    timer.current = handle;
    return () => {
      clearTimeout(handle);
      if (timer.current === handle) {
        timer.current = null;
      }
    };
  }, [open, denied, nextRefresh]);

  return {
    ...data,
    workId,
    role,
    denied,
    historyOpen,
    eventsOpen,
    close: clear,
    refresh: () =>
      setRefreshRequest((current) => ({
        revision: current.revision + 1,
        kind: "manual",
      })),
    selectWork: (value: WorkId) => {
      if (value === workId) {
        return;
      }
      cancel();
      refreshState.current.team = false;
      update("team", { kind: "idle" });
      update("rolePage", { kind: "idle" });
      setRole(null);
      setWorkId(value);
    },
    selectRole: (value: InspectionRoleSelection | null) => {
      if (
        value &&
        role &&
        value.role === role.role &&
        value.cursor === role.cursor &&
        (value.section === "tasks") === (role.section === "tasks")
      ) {
        setRole(value);
        return;
      }
      cancel();
      update("rolePage", { kind: "idle" });
      setRole(value);
    },
    showHistory: (cursor?: string) => {
      if (historyOpen && historyCursor === cursor) {
        return;
      }
      cancel();
      update("history", { kind: "idle" });
      setHistoryQuery({ kind: "history", ...(cursor ? { cursor } : {}) });
    },
    showEvents: (cursor?: string) => {
      if (eventsOpen && eventsCursor === cursor) {
        return;
      }
      cancel();
      update("events", { kind: "idle" });
      setEventsQuery({ kind: "events", ...(cursor ? { cursor } : {}) });
    },
  };
};
