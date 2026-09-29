import { connect } from "cloudflare:sockets";
import postgres from "postgres";

const fixtureUrl = "postgres://slice:slice-local-only@postgres-tls:5432/slice";
const certificatePattern =
  /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/u;
export const isFixtureCertificate = (pem: string): boolean =>
  pem.length <= 8192 && certificatePattern.test(pem);
interface TlsAttempt {
  accepted: boolean;
  failure?: "unknown-issuer" | "timeout" | "other";
}
const classify = (error: unknown): TlsAttempt["failure"] => {
  const message = error instanceof Error ? error.message : "";
  if (
    /unknownissuer|unknown issuer|self.signed|unable to verify|unable to get local issuer/iu.test(
      message
    )
  ) {
    return "unknown-issuer";
  }
  if (/timeout|timed out/iu.test(message)) {
    return "timeout";
  }
  return "other";
};
const withDeadline = async <T>(
  operation: Promise<T>,
  milliseconds: number
): Promise<T> => {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timeout.reject(new Error("TLS probe timeout"));
  }, milliseconds);
  try {
    return await Promise.race([operation, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
};
const rawPostgresTls = async (): Promise<TlsAttempt> => {
  let socket = connect(
    { hostname: "postgres-tls", port: 5432 },
    { allowHalfOpen: false, secureTransport: "starttls" }
  );
  try {
    await withDeadline(
      (async () => {
        await socket.opened;
        const writer = socket.writable.getWriter();
        await writer.write(new Uint8Array([0, 0, 0, 8, 4, 210, 22, 47]));
        writer.releaseLock();
        const reader = socket.readable.getReader();
        const result = await reader.read();
        reader.releaseLock();
        if (result.value?.length !== 1 || result.value[0] !== 83) {
          throw new Error("PostgreSQL TLS negotiation failed");
        }
        socket = socket.startTls({ expectedServerHostname: "postgres-tls" });
        await socket.opened;
      })(),
      8000
    );
    return { accepted: true };
  } catch (error) {
    return { accepted: false, failure: classify(error) };
  } finally {
    try {
      await withDeadline(socket.close(), 1000);
    } catch {
      // celld closes any remaining socket when this request event ends.
    }
  }
};
const driverPostgresTls = async (ca: string): Promise<TlsAttempt> => {
  const client = postgres(fixtureUrl, {
    connect_timeout: 5,
    idle_timeout: 1,
    max: 1,
    prepare: false,
    ssl: { ca, rejectUnauthorized: true },
  });
  try {
    await withDeadline(client`select 1`.execute(), 8000);
    return { accepted: true };
  } catch (error) {
    return { accepted: false, failure: classify(error) };
  } finally {
    await client.end({ timeout: 1 });
  }
};
export const probePrivateCa = async (ca: string) => {
  if (!isFixtureCertificate(ca)) {
    throw new Error("Invalid fixture certificate");
  }
  const rawSocket = await rawPostgresTls();
  const driverWithPrivateCa = await driverPostgresTls(ca);
  return {
    driverWithPrivateCa,
    publiclyTrustedPostgres: "not-tested",
    rawSocket,
    target: "postgres-tls:5432",
  };
};
