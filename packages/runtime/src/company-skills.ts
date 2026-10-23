import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { skills } from "agents/harness/pi";
import type { SkillSource } from "agents/skills";
import { Schema } from "effect";

export interface CompanySkill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

const companySkillSource = (entries: readonly CompanySkill[]): SkillSource => ({
  fingerprint: JSON.stringify(entries),
  id: "cerebro-company-skills",
  list: () =>
    Promise.resolve(
      entries.map(({ description, name }) => ({ description, name }))
    ),
  load: (name) =>
    Promise.resolve(entries.find((entry) => entry.name === name) ?? null),
});

const textOutput = Schema.Array(
  Schema.Struct({ text: Schema.String, type: Schema.Literal("text") })
);
const skillResult = Schema.Union([
  Schema.Struct({
    isError: Schema.optional(Schema.Boolean),
    output: textOutput,
  }),
  Schema.Struct({
    content: textOutput,
    isError: Schema.optional(Schema.Boolean),
  }),
]);

const nativeSkillTool = (tool: ToolRegistration): ToolRegistration => ({
  ...tool,
  execute: async (args, api, context) => {
    const result: unknown = await tool.execute(args, api, context);
    const decoded = Schema.decodeUnknownSync(skillResult)(result);
    return {
      ...(decoded.isError === undefined ? {} : { isError: decoded.isError }),
      output: [...("output" in decoded ? decoded.output : decoded.content)],
    };
  },
});

export const companySkillsExtension = async (
  entries: readonly CompanySkill[]
): Promise<Extension> => {
  const extension = await skills([companySkillSource(entries)]);
  return {
    ...extension,
    tools: extension.tools?.map(nativeSkillTool),
  };
};
