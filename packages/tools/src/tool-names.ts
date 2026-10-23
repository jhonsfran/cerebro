const internalToolNames = new Set([
  "activate_skill",
  "read_skill_resource",
  "subagent",
  "search_history",
  "search_conversations",
  "schedule",
  "cancel_schedule",
]);

export const isInternalToolName = (name: string): boolean =>
  internalToolNames.has(name);
