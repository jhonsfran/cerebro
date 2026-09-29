import { spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.resolve(
  process.env.TLS_FIXTURE_DIR ??
    fileURLToPath(new URL("../results/tls", import.meta.url))
);
await mkdir(directory, { mode: 0o755, recursive: true });
await chmod(directory, 0o755);
const openssl = (args) => {
  const result = spawnSync("openssl", args, {
    cwd: directory,
    stdio: "pipe",
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error("TLS fixture certificate generation failed");
  }
};
openssl([
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-days",
  "2",
  "-subj",
  "/CN=Cerebro local fixture CA",
  "-addext",
  "basicConstraints=critical,CA:TRUE",
  "-addext",
  "keyUsage=critical,keyCertSign,cRLSign",
  "-keyout",
  "ca.key",
  "-out",
  "ca.crt",
]);
openssl([
  "req",
  "-new",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-subj",
  "/CN=postgres-tls",
  "-keyout",
  "server.key",
  "-out",
  "server.csr",
]);
await writeFile(
  path.join(directory, "server.ext"),
  "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:postgres-tls\n"
);
openssl([
  "x509",
  "-req",
  "-in",
  "server.csr",
  "-CA",
  "ca.crt",
  "-CAkey",
  "ca.key",
  "-CAcreateserial",
  "-days",
  "2",
  "-extfile",
  "server.ext",
  "-out",
  "server.crt",
]);
await chmod(path.join(directory, "ca.key"), 0o600);
await chmod(path.join(directory, "server.key"), 0o600);
await writeFile(
  path.join(directory, "pg_hba.conf"),
  "local all all trust\nhostnossl all all all reject\nhostssl all all all scram-sha-256\n"
);
await Promise.all(
  ["ca.crt", "server.crt", "pg_hba.conf"].map(async (name) => {
    await chmod(path.join(directory, name), 0o644);
  })
);
process.stdout.write(
  "Generated local TLS fixture certificates under ignored results/tls.\n"
);
