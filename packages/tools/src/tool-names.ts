const internalToolNames = new Set([
  "activate_skill",
  "render_ui",
  "read_skill_resource",
  "subagent",
  "search_history",
  "search_conversations",
  "schedule",
  "cancel_schedule",
  "start_team",
  "get_work",
  "message_team",
  "stop_work",
]);

export const isInternalToolName = (name: string): boolean =>
  internalToolNames.has(name);
