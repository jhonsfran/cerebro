// These names belong to the agents.skills extension, never to a connector.
const internalToolNames = new Set(["activate_skill", "read_skill_resource"]);

export const isInternalToolName = (name: string): boolean =>
  internalToolNames.has(name);
