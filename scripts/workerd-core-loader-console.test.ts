/**
 * What isolates core loads in its own Loader print off Cloudflare
 * (GRA-910): nothing, as on Cloudflare, where a Loader isolate without a
 * tail has its output dropped. Core runs them itself only where
 * `SANDBOX_IN_PROCESS=unbounded` says so, with no `SANDBOX_HOST`; its
 * stdout and stderr are the deployment's logs there. A stand-in core
 * (apps/core/test/workerd/core-loader-console-worker.ts) runs an isolate
 * that logs a value every way it can and leaves errors uncaught, on a
 * workerd served `--verbose`, which prints those too: the answer carries
 * the value, workerd's output never does. The same isolate loaded as it is
 * prints it, which shows the output is read.
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
  values: z.object({ call: z.string(), js: z.string(), control: z.string() }),
});

describe("isolates core loads itself off Cloudflare, on a workerd served --verbose", () => {
  let served: Served;

  beforeAll(async () => {
    const out = tempDir();
    const modules = bundle(out, "core-loader-console-worker.ts");
    served = await serveOnWorkerd(
      out,
      (address) => `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(name = "core", worker = .core)],
  sockets = [(name = "http", address = "${address}", http = (), service = "core")],
);

const core :Workerd.Worker = (
  modules = [${modules.join(", ")}],
  compatibilityDate = "2026-09-15",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [
    (name = "LOADER", workerLoader = ()),
    (name = "RUNTIME_PROFILE", text = "workerd"),
    (name = "SANDBOX_IN_PROCESS", text = "unbounded"),
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

  it("print nothing of what they log or leave uncaught, where the same isolate loaded as it is does", async () => {
    const run = async (route: string) => {
      const response = await fetch(new URL(route, served.url));
      return ranSchema.parse(await response.json());
    };
    const call = await run("/call");
    const js = await run("/js");
    const hashbang = await run("/hashbang");
    const control = await run("/control");
    const { values } = control;
    await sleep(SETTLE_MS);

    expect({
      answered: [
        call.answered,
        js.answered,
        hashbang.answered,
        control.answered,
      ],
      call: served.logs().includes(values.call),
      js: served.logs().includes(values.js),
      control: served.logs().includes(values.control),
    }).toStrictEqual({
      answered: [values.call, values.js, values.js, values.control],
      call: false,
      js: false,
      control: true,
    });
  });

  it("refuses to load a main module that can't be silenced first", async () => {
    const response = await fetch(new URL("/cjs", served.url));
    const { answered } = ranSchema.parse(await response.json());

    expect(answered).toBe("refused");
  });
});
