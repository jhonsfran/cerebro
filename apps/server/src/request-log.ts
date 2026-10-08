const routes = [
  /^\/api\/product\/conversations\/[^/]+\/messages$/u,
  /^\/api\/product\/conversations\/[^/]+\/(?:events|history)$/u,
  /^\/api\/product\/conversations\/[^/]+\/(?:sources|audit)\/[^/]+$/u,
  /^\/api\/product\/conversations\/[^/]+$/u,
  /^\/api\/product\/agents\/[^/]+(?:\/(?:access|history))?$/u,
];
const templates = [
  "/api/product/conversations/:conversationId/messages",
  "/api/product/conversations/:conversationId/stream",
  "/api/product/conversations/:conversationId/content/:resourceId",
  "/api/product/conversations/:conversationId",
  "/api/product/agents/:agentId",
];
const staticRoutes = new Set([
  "/",
  "/health",
  "/ready",
  "/api/product/setup",
  "/api/product/catalog",
  "/api/product/agents",
  "/api/product/conversations",
  "/api/product/admin",
  "/api/channels/slack/events",
  "/api/fixture/runtime/isolation",
  "/api/fixture/runtime/observers",
  "/api/fixture/audit/replay",
]);
export const requestRoute = (pathname: string): string => {
  if (staticRoutes.has(pathname)) {
    return pathname;
  }
  const index = routes.findIndex((route) => route.test(pathname));
  if (index !== -1) {
    return templates[index] ?? "unknown";
  }
  if (pathname.startsWith("/api/auth/")) {
    return "/api/auth/:action";
  }
  if (pathname.startsWith("/rpc/")) {
    return "/rpc/:procedure";
  }
  if (pathname.startsWith("/fixture/sessions/")) {
    return "/fixture/sessions/:name";
  }
  return "unknown";
};
export const logRequest = (record: {
  traceId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
}): void => {
  const codes: Readonly<Record<number, string>> = {
    401: "unauthorized",
    403: "forbidden",
    503: "provider-unavailable",
  };
  const errorCode =
    record.status >= 400
      ? (codes[record.status] ?? "request-failed")
      : undefined;
  console.info(
    JSON.stringify({
      ...record,
      errorCode,
      event: "http.request",
      service: "cerebro-api",
    })
  );
};
