import assert from "node:assert/strict";

import { Schema } from "effect";

import {
  InspectionFrame,
  InspectionQuery,
} from "../../../packages/contracts/src/inspection.ts";
import type { WorkId } from "../../../packages/contracts/src/work.ts";
import { waitForFixture } from "../../slice-1/application.ts";
import { fixture, metadata } from "./team-support.ts";

export const inspect = async (
  route: string,
  query: InspectionQuery,
  cookie = metadata.owner.cookie
) => {
  const checked = Schema.decodeUnknownSync(InspectionQuery)(query);
  const response = await fixture.request(`${route}/inspection`, cookie, {
    query: checked,
  });
  assert.equal(response.status, 200, await response.clone().text());
  return Schema.decodeUnknownSync(InspectionFrame)(await response.json());
};
export const overview = async (route: string) => {
  const frame = await inspect(route, { kind: "overview" });
  assert.ok(frame.kind === "overview");
  return frame;
};
export const waitTeamAdmission = async (
  route: string,
  workId: WorkId,
  before: Extract<InspectionFrame, { kind: "tasks" }>
) => {
  assert.equal(before.workId, workId);
  assert.equal(before.role, 0);
  const previous = new Set(before.tasks.map((task) => task.id));
  const after = await waitForFixture(
    () =>
      inspect(route, {
        kind: "tasks",
        workId,
        role: 0,
      }),
    (value) =>
      value.kind === "tasks" &&
      value.tasks.some(
        (task) =>
          !previous.has(task.id) &&
          task.kind === "cerebro.team-admission" &&
          task.status === "terminal" &&
          task.outcome === "completed"
      ),
    60_000
  );
  assert.ok(after.kind === "tasks");
  const admissions = after.tasks.filter(
    (task) => !previous.has(task.id) && task.kind === "cerebro.team-admission"
  );
  assert.equal(admissions.length, 1);
  const [admission] = admissions;
  assert.ok(
    admission?.status === "terminal" && admission.outcome === "completed"
  );
  return { before, after, admission };
};
