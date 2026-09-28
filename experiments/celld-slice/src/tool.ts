import { WorkerEntrypoint } from "cloudflare:workers";

interface FetchCapability {
  fetch: (request: Request | string) => Promise<Response>;
}

interface RestrictedWorkerCode {
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, string>;
  globalOutbound: null;
  env: { GATEWAY: FetchCapability };
}

export interface ToolBindings {
  GATEWAY: FetchCapability;
  LOADER: {
    get: (
      id: string,
      getCode: () => RestrictedWorkerCode
    ) => { getEntrypoint: () => FetchCapability };
  };
}

const fixtureHealthUrl = "http://fixture:8090/health";
const workerSource = `
export default {
  async fetch(request, env) {
    let direct;
    try {
      const response = await fetch("http://fixture:8090/health");
      await response.text();
      direct = { denied: false, status: response.status };
    } catch (error) {
      direct = {
        denied: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    let capability;
    try {
      const response = await env.GATEWAY.fetch(
        "https://fixture-gateway.invalid/health",
      );
      capability = {
        status: response.status,
        body: await response.json(),
      };
    } catch (error) {
      capability = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return Response.json({ direct, capability });
  },
};
`;

export class FixtureGateway extends WorkerEntrypoint {
  // oxlint-disable-next-line class-methods-use-this -- WorkerEntrypoint requires a prototype fetch method.
  fetch(): Response {
    return Response.json({ capability: true, ok: true });
  }
}

export const probeToolIsolation = async (env: ToolBindings) => {
  const fixtureResponse = await fetch(fixtureHealthUrl);
  await fixtureResponse.text();
  const worker = env.LOADER.get("cerebro-isolation-v1", () => ({
    compatibilityDate: "2026-08-30",
    env: { GATEWAY: env.GATEWAY },
    globalOutbound: null,
    mainModule: "tool.js",
    modules: { "tool.js": workerSource },
  }));
  const response = await worker
    .getEntrypoint()
    .fetch("https://isolation-probe.invalid/");
  const observations: unknown = await response.json();
  return {
    fixtureReachable: fixtureResponse.ok,
    fixtureStatus: fixtureResponse.status,
    observations,
    workerStatus: response.status,
  };
};
