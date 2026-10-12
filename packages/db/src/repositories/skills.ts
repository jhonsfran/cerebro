import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../index.ts";
import { skill } from "../schema/skills.ts";

export interface SkillRecord {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export const listSkills = async (
  database: Database,
  organizationId: string
): Promise<readonly SkillRecord[]> =>
  await database
    .select({
      body: skill.body,
      description: skill.description,
      name: skill.name,
    })
    .from(skill)
    .where(eq(skill.organizationId, organizationId))
    .orderBy(skill.name);

export const putSkill = async (
  database: Database,
  input: SkillRecord & {
    readonly organizationId: string;
    readonly principalId: string;
  }
): Promise<void> => {
  await database
    .insert(skill)
    .values({
      body: input.body,
      description: input.description,
      name: input.name,
      organizationId: input.organizationId,
      updatedBy: input.principalId,
    })
    .onConflictDoUpdate({
      set: {
        body: input.body,
        description: input.description,
        updatedAt: sql`now()`,
        updatedBy: input.principalId,
      },
      target: [skill.organizationId, skill.name],
    });
};

export const deleteSkill = async (
  database: Database,
  organizationId: string,
  name: string
): Promise<boolean> => {
  const removed = await database
    .delete(skill)
    .where(and(eq(skill.organizationId, organizationId), eq(skill.name, name)))
    .returning({ name: skill.name });
  return removed.length > 0;
};
