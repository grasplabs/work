/**
 * What a native connector's isolate prints off Cloudflare (GRA-940):
 * nothing, as on Cloudflare, where a Loader isolate without a tail has its
 * output dropped. Connect loads one for every native action call, on
 * either profile; on plain workerd its stdout and stderr are the
 * deployment's logs. A stand-in connect
 * (apps/connect/test/workerd/connector-console-worker.ts) loads, through
 * connect's own `loadConnector`, a connector that logs a value every way it
 * can and leaves errors uncaught, on a workerd served `--verbose`, which
 * prints those too: the answer carries the value, workerd's output never
 * does. The same connector loaded as it is prints it, which shows the
 * output is read.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { bundle } from "./workerd-stand-in.ts";
import { cleanUp, serveOnWorkerd, tempDir } from "./workerd-test-server.ts";
import type { Served } from "./workerd-test-server.ts";

/** How long an isolate's last output may take to come through. */
const SETTLE_MS = 500;

const ranSchema = z.object({
  answered: z.unknown(),
  values: z.object({ connector: z.string(), control: z.string() }),
});

describe("a native connector's isolate connect loads, on a workerd served --verbose", () => {
  let served: Served;

  beforeAll(async () => {
    const out = tempDir();
    const modules = bundle(out, "connector-console-worker.ts", "connect");
    served = await serveOnWorkerd(
      out,
      (address) => `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(name = "connect", worker = .connect)],
  sockets = [(name = "http", address = "${address}", http = (), service = "connect")],
);

const connect :Workerd.Worker = (
  modules = [${modules.join(", ")}],
  compatibilityDate = "2026-09-15",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [
    (name = "LOADER", workerLoader = ()),
    (name = "EGRESS", service = "connect"),
  ],
);
`,
      // The loader is experimental in workerd; an isolate's uncaught error
      // is printed at info level only.
      ["--experimental", "--verbose"]
    );
  }, 120_000);

  afterAll(() => {
    cleanUp();
  });

  it("prints nothing of what it logs or leaves uncaught, where the same connector loaded as it is does", async () => {
    const run = async (route: string) => {
      const response = await fetch(new URL(route, served.url));
      return ranSchema.parse(await response.json());
    };
    const connector = await run("/connector");
    const control = await run("/control");
    const { values } = control;
    await sleep(SETTLE_MS);

    expect({
      answered: [connector.answered, control.answered],
      connector: served.logs().includes(values.connector),
      control: served.logs().includes(values.control),
    }).toStrictEqual({
      answered: [values.connector, values.control],
      connector: false,
      control: true,
    });
  });

  // Each way a connector's code can have workerd report an error with its
  // message: the same connector loaded as it is reports it, which shows the
  // path is read; through `loadConnector`, nothing. What a default
  // export's handler hands its own context's `waitUntil` is still
  // reported: pinned so a change is seen (GRA-939).
  it.each([
    ["setImmediate", false],
    ["waitUntil", true],
  ])(
    "reports %s from a connector loaded as it is, and from one loadConnector loads: %s",
    async (name, reported) => {
      const run = async (route: string) => {
        const response = await fetch(new URL(route, served.url));
        return z.object({ answered: z.string() }).parse(await response.json())
          .answered;
      };
      const quiet = await run(`/path/${name}`);
      const loud = await run(`/loud-path/${name}`);
      await sleep(SETTLE_MS);

      expect({
        answered: [quiet, loud],
        quiet: served.logs().includes(quiet),
        loud: served.logs().includes(loud),
      }).toStrictEqual({
        answered: [`quiet-${name}-2c8e`, `loud-${name}-2c8e`],
        quiet: reported,
        loud: true,
      });
    }
  );
});
