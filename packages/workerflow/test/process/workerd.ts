// Test-only harness: serves test/death-fixture.ts on plain workerd (no
// Wrangler dev, no Miniflare) with disk-backed Durable Object storage, kills
// the process with SIGKILL and starts it again on the same directory.
//
// workerd needs no `--experimental` for any of this: SQLite-backed objects,
// alarms and `localDisk` storage run without it. (workerd.capnp still
// labels `localDisk` experimental in a comment.)
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { until } from "./outside.ts";

const require = createRequire(import.meta.url);
const packageRoot = path.join(import.meta.dirname, "../..");
const workerdBinary = path.join(
  path.dirname(require.resolve("workerd/package.json")),
  "bin/workerd"
);
const wranglerCli = path.join(
  path.dirname(require.resolve("wrangler/package.json")),
  "bin/wrangler.js"
);

/**
 * Bundles the fixture the way a deploy would, into `directory`, and returns
 * the module's path.
 */
export const bundleFixture = (directory: string): string => {
  execFileSync(
    process.execPath,
    [
      wranglerCli,
      "deploy",
      "--dry-run",
      "--outdir",
      directory,
      "--name",
      "workerflow-death",
      "--compatibility-date",
      "2026-09-15",
      "test/death-fixture.ts",
    ],
    { cwd: packageRoot, stdio: "pipe" }
  );
  const module = readdirSync(directory).find((file) => file.endsWith(".js"));
  if (module === undefined) {
    throw new Error("wrangler wrote no module");
  }
  return path.join(directory, module);
};

const freePort = async (): Promise<number> => {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  probe.close();
  await once(probe, "close");
  if (address === null || typeof address === "string") {
    throw new Error("no free port for workerd");
  }
  return address.port;
};

const config = (storage: string, port: number, effectsPort: number): string =>
  `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .main),
    (name = "storage", disk = (path = "${storage}", writable = true)),
    (name = "effects", external = (address = "127.0.0.1:${effectsPort}", http = ())),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);

const main :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "worker.js")],
  compatibilityDate = "2026-09-15",
  bindings = [
    (name = "RUNS", durableObjectNamespace = "Runs"),
    (name = "EFFECTS", service = "effects"),
  ],
  durableObjectNamespaces = [(className = "Runs", uniqueKey = "workerflow-runs", enableSql = true)],
  durableObjectStorage = (localDisk = "storage"),
);
`;

/** Plain workerd serving the fixture, on storage that outlives it. */
export class Workerd {
  readonly #work: string;
  readonly #config: string;
  readonly url: string;
  #process: ChildProcess | undefined;
  #log = "";

  private constructor(work: string, configPath: string, port: number) {
    this.#work = work;
    this.#config = configPath;
    this.url = `http://127.0.0.1:${port}`;
  }

  /** A fresh storage directory, with the bundled fixture next to it. */
  static async create(module: string, effectsPort: number): Promise<Workerd> {
    const work = mkdtempSync(path.join(tmpdir(), "workerflow-death-"));
    const storage = path.join(work, "storage");
    mkdirSync(storage);
    // workerd embeds a module by a path relative to its config.
    copyFileSync(module, path.join(work, "worker.js"));
    const port = await freePort();
    const configPath = path.join(work, "config.capnp");
    writeFileSync(configPath, config(storage, port, effectsPort));
    return new Workerd(work, configPath, port);
  }

  /**
   * Starts workerd on the storage directory and waits until it answers on
   * a path that touches no run object, so a test can tell that a run
   * resumed with no request reaching it.
   */
  async start(): Promise<void> {
    const child = spawn(workerdBinary, ["serve", this.#config], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#process = child;
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk: Buffer) => {
        this.#log += chunk.toString();
      });
    }
    await until("workerd to answer", async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`workerd exited at start:\n${this.#log.slice(-2000)}`);
      }
      let ready = false;
      try {
        const response = await fetch(`${this.url}/ready`);
        ready = response.status === 204;
      } catch {
        // Not listening yet.
      }
      return ready || undefined;
    });
  }

  /** SIGKILL: no shutdown, nothing flushed beyond what the OS has. */
  async kill(): Promise<void> {
    const child = this.#process;
    if (
      child === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return;
    }
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }

  async restart(): Promise<void> {
    await this.kill();
    await this.start();
  }

  async request(
    pathname: string,
    body?: unknown
  ): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${this.url}${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed: unknown = await response.json();
    return { status: response.status, body: parsed };
  }

  async dispose(): Promise<void> {
    await this.kill();
    rmSync(this.#work, { recursive: true, force: true });
  }
}
