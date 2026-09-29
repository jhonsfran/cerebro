import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const project = process.env.COMPOSE_PROJECT_NAME ?? "cerebro-slice";
const command =
  'fetch("http://127.0.0.1:8081/state").then(r=>r.json()).then(s=>console.log(JSON.stringify({isolates:s.deployment.isolates,residents:s.residents,rss_bytes:s.rss_bytes})))';
const state = JSON.parse(
  execFileSync(
    "rtk",
    [
      "proxy",
      "docker",
      "compose",
      "-p",
      project,
      "-f",
      "experiments/celld-slice/compose.yaml",
      "exec",
      "-T",
      "celld",
      "node",
      "-e",
      command,
    ],
    { cwd: root, encoding: "utf-8", timeout: 15_000 }
  )
);
const residentClasses = {};
for (const resident of state.residents) {
  const [name] = resident.split(":");
  residentClasses[name] = (residentClasses[name] ?? 0) + 1;
}
const result = {
  heapMetric:
    "Pool aggregate committed physical V8 heap; busy heaps can be omitted",
  isolates: state.isolates,
  label: process.argv[2] ?? "observation",
  project,
  residentClasses,
  residentCount: state.residents.length,
  rssBytes: state.rss_bytes,
  timestamp: new Date().toISOString(),
};
const output = new URL("../results/census-history.json", import.meta.url);
let history = [];
try {
  history = JSON.parse(await readFile(output, "utf-8"));
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}
await mkdir(new URL("../results/", import.meta.url), { recursive: true });
history.push(result);
await writeFile(output, `${JSON.stringify(history, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
