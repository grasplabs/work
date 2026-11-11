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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

import { requestTimeoutMs, until } from "./outside.ts";

/** Bundling the fixture takes seconds; a stuck Wrangler fails the suite. */
const bundleTimeoutMs = 120_000;

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
      // Before the flags: `--compatibility-flags` takes a list, and would
      // take the script after it as one more.
      "test/death-fixture.ts",
      "--dry-run",
      "--outdir",
      directory,
      "--name",
      "workerflow-death",
      "--compatibility-date",
      "2026-09-15",
      "--compatibility-flags",
      "nodejs_als",
    ],
    { cwd: packageRoot, stdio: "pipe", timeout: bundleTimeoutMs }
  );
  const module = readdirSync(directory).find((file) => file.endsWith(".js"));
  if (module === undefined) {
    throw new Error("wrangler wrote no module");
  }
  return path.join(directory, module);
};

/** Where workerd reports its sockets: the child's stdio after stderr. */
const controlFd = 3;

/** What workerd's control descriptor says once the socket listens. */
const isListening = (
  value: unknown
): value is { event: "listen"; socket: "http"; port: number } =>
  typeof value === "object" &&
  value !== null &&
  "event" in value &&
  value.event === "listen" &&
  "socket" in value &&
  value.socket === "http" &&
  "port" in value &&
  typeof value.port === "number";

/** The deploy a fresh workerd serves until a test redeploys it. */
const firstDeploy = "1";

const config = (storage: string, effectsPort: number, deploy: string): string =>
  `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .main),
    (name = "storage", disk = (path = "${storage}", writable = true)),
    (name = "effects", external = (address = "127.0.0.1:${effectsPort}", http = ())),
  ],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "main")],
);

const main :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "worker.js")],
  compatibilityDate = "2026-09-15",
  compatibilityFlags = ["nodejs_als"],
  bindings = [
    (name = "RUNS", durableObjectNamespace = "Runs"),
    (name = "EFFECTS", service = "effects"),
    (name = "DEPLOY", text = "${deploy}"),
  ],
  durableObjectNamespaces = [(className = "Runs", uniqueKey = "workerflow-runs", enableSql = true)],
  durableObjectStorage = (localDisk = "storage"),
);
`;

/**
 * Plain workerd serving the fixture, on storage that outlives it.
 *
 * Each start listens on a port the kernel picks, which workerd reports on
 * its control descriptor. A port probed free beforehand can be taken
 * before workerd binds it, by another test file's workerd started again
 * after a kill: this one then fails to bind, and its test drives the
 * other's runs, whose effects reach the other file's outside world.
 */
export class Workerd {
  readonly #work: string;
  readonly #config: string;
  readonly #storage: string;
  readonly #effectsPort: number;
  #port: number | undefined;
  #process: ChildProcess | undefined;
  #log = "";

  private constructor(work: string, effectsPort: number) {
    this.#work = work;
    this.#config = path.join(work, "config.capnp");
    this.#storage = path.join(work, "storage");
    this.#effectsPort = effectsPort;
    this.#configure(firstDeploy);
  }

  /** Where the process listens: another port after each start. */
  get url(): string {
    if (this.#port === undefined) {
      throw new Error("workerd isn't listening");
    }
    return `http://127.0.0.1:${this.#port}`;
  }

  #configure(deploy: string): void {
    writeFileSync(
      this.#config,
      config(this.#storage, this.#effectsPort, deploy)
    );
  }

  /** A fresh storage directory, with the bundled fixture next to it. */
  static create(module: string, effectsPort: number): Workerd {
    const work = mkdtempSync(path.join(tmpdir(), "workerflow-death-"));
    const storage = path.join(work, "storage");
    mkdirSync(storage);
    // workerd embeds a module by a path relative to its config.
    copyFileSync(module, path.join(work, "worker.js"));
    return new Workerd(work, effectsPort);
  }

  /**
   * Starts workerd on the storage directory and waits until it answers on
   * a path that touches no run object, so a test can tell that a run
   * resumed with no request reaching it.
   */
  async start(): Promise<void> {
    this.#port = undefined;
    const child = spawn(
      workerdBinary,
      ["serve", this.#config, `--control-fd=${controlFd}`],
      { stdio: ["ignore", "pipe", "pipe", "pipe"] }
    );
    this.#process = child;
    const [, stdout, stderr, control] = child.stdio;
    if (
      !(stdout instanceof Readable) ||
      !(stderr instanceof Readable) ||
      !(control instanceof Readable)
    ) {
      throw new TypeError("workerd's output isn't piped");
    }
    createInterface({ input: control }).on("line", (line) => {
      const message: unknown = JSON.parse(line);
      // Only the process started last says where this one listens.
      if (isListening(message) && this.#process === child) {
        this.#port = message.port;
      }
    });
    // If the test process exits without disposing (a crash, a timeout),
    // workerd goes with it rather than outlive it.
    const killOnExit = (): void => {
      child.kill("SIGKILL");
    };
    process.once("exit", killOnExit);
    child.once("exit", () => {
      process.off("exit", killOnExit);
    });
    for (const stream of [stdout, stderr]) {
      stream.on("data", (chunk: Buffer) => {
        this.#log += chunk.toString();
      });
    }
    await until("workerd to answer", async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`workerd exited at start:\n${this.#log.slice(-2000)}`);
      }
      let ready = false;
      // Unset until workerd says where it listens.
      if (this.#port !== undefined) {
        try {
          const response = await fetch(`${this.url}/ready`, {
            signal: AbortSignal.timeout(requestTimeoutMs),
          });
          ready = response.status === 204;
        } catch {
          // Not serving yet.
        }
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

  /**
   * A deploy: kills the process and starts it again on the same storage,
   * serving the fixture's `deploy` (its `DEPLOY` binding), as a release
   * that changed the code under the runs out.
   */
  async redeploy(deploy: string): Promise<void> {
    await this.kill();
    this.#configure(deploy);
    await this.start();
  }

  async request(
    pathname: string,
    body?: unknown
  ): Promise<{ status: number; body: unknown }> {
    // The signal bounds the body read as well as the answer.
    const response = await fetch(`${this.url}${pathname}`, {
      signal: AbortSignal.timeout(requestTimeoutMs),
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed: unknown = await response.json();
    return { status: response.status, body: parsed };
  }

  /** A GET whose answer is bytes, with its headers. */
  async bytes(
    pathname: string
  ): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
    // The signal bounds the body read as well as the answer.
    const response = await fetch(`${this.url}${pathname}`, {
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const body = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, body };
  }

  async dispose(): Promise<void> {
    await this.kill();
    rmSync(this.#work, { recursive: true, force: true });
  }
}
