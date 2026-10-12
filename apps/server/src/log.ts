// Route names in logs never carry IDs: a segment after a collection name is
// replaced by ":id". Paths outside the API are logged as "unknown".
const COLLECTIONS = new Set([
  "access",
  "agents",
  "approvals",
  "audit",
  "conversations",
  "runs",
  "sources",
]);
const STATIC_ROUTES = new Set(["/", "/health", "/ready"]);

export const requestRoute = (pathname: string): string => {
  if (STATIC_ROUTES.has(pathname)) {
    return pathname;
  }
  if (pathname.startsWith("/api/auth/")) {
    return "/api/auth/:action";
  }
  if (pathname.startsWith("/rpc/")) {
    return "/rpc/:procedure";
  }
  if (
    !pathname.startsWith("/api/product/") &&
    !pathname.startsWith("/api/channels/slack/")
  ) {
    return "unknown";
  }
  const segments = pathname.split("/");
  return segments
    .map((segment, index) =>
      index > 0 && COLLECTIONS.has(segments[index - 1] ?? "") ? ":id" : segment
    )
    .join("/");
};

const ERROR_CODES: Readonly<Record<number, string>> = {
  401: "unauthorized",
  403: "forbidden",
  503: "provider-unavailable",
};

export const logRequest = (record: {
  readonly traceId: string;
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
}): void => {
  console.info(
    JSON.stringify({
      ...record,
      errorCode:
        record.status >= 400
          ? (ERROR_CODES[record.status] ?? "request-failed")
          : undefined,
      event: "http.request",
      service: "cerebro-api",
    })
  );
};
