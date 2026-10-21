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
  values: z.object({
    call: z.string(),
    js: z.string(),
    nested: z.string(),
    carriage: z.string(),
    thrown: z.string(),
    control: z.string(),
  }),
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
    const nested = await run("/nested");
    const carriage = await run("/carriage");
    const control = await run("/control");
    const { values } = control;
    await sleep(SETTLE_MS);

    expect({
      answered: [
        call.answered,
        js.answered,
        hashbang.answered,
        nested.answered,
        carriage.answered,
        control.answered,
      ],
      call: served.logs().includes(values.call),
      js: served.logs().includes(values.js),
      nested: served.logs().includes(values.nested),
      carriage: served.logs().includes(values.carriage),
      control: served.logs().includes(values.control),
    }).toStrictEqual({
      answered: [
        values.call,
        values.js,
        values.js,
        values.nested,
        values.carriage,
        values.control,
      ],
      call: false,
      js: false,
      nested: false,
      carriage: false,
      control: true,
    });
  });

  // What the quiet module can't stop: workerd served `--verbose` reports
  // an exception thrown out of a call, as it hands it to the caller, and
  // what a callback of a timer imported by name from `node:timers` throws
  // (the binding is the module's own, which nothing loaded first can
  // change). Pinned so a change to either is seen (GRA-939); without
  // `--verbose`, as the supervisor and a deployment run, neither is
  // printed.
  it("still has a call's thrown error and a named node:timers timer's reported by a workerd served --verbose", async () => {
    const thrown = await fetch(new URL("/thrown", served.url));
    const { answered, values } = ranSchema.parse(await thrown.json());
    const named = await fetch(new URL("/path/nodeNamedSetTimeout", served.url));
    const namedValue = z
      .object({ answered: z.string() })
      .parse(await named.json()).answered;
    await sleep(SETTLE_MS);

    expect({
      answered,
      reported: served.logs().includes(values.thrown),
      named: served.logs().includes(namedValue),
    }).toStrictEqual({ answered: "threw", reported: true, named: true });
  });

  // Each way an isolate's code can have workerd report an error with its
  // message: the same isolate loaded as it is reports it, which shows the
  // path is read; silenced, it reports nothing.
  it.each([
    ["setImmediate"],
    ["nodeSetTimeout"],
    ["nodeSetImmediate"],
    ["waitUntil"],
  ])(
    "prints nothing an isolate's %s leaves uncaught, where the isolate loaded as it is does",
    async (name) => {
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
        answered: [`quiet-${name}-6d1f`, `loud-${name}-6d1f`],
        quiet: false,
        loud: true,
      });
    }
  );

  it("refuses to load a main module that can't be silenced first", async () => {
    const response = await fetch(new URL("/cjs", served.url));
    const { answered } = ranSchema.parse(await response.json());

    expect(answered).toBe("refused");
  });
});
