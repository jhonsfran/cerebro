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
  "list_work",
  "recall_work",
  "message_team",
  "stop_work",
  "delegate_worker",
  "subscribe_work",
  "unsubscribe_work",
  "return_event",
]);

export const isInternalToolName = (name: string): boolean =>
  internalToolNames.has(name);
