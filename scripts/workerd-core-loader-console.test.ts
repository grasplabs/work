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

import { maxThrownMessage } from "@grasp-os/shared/quiet-loader";
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

  // What an entrypoint's call throws crosses as a value and is thrown
  // again host-side (GRA-939): of the same kind, with its code and its
  // message, which is cut at `maxThrownMessage`. Workerd reports nothing of
  // it, and the entrypoint's own calls of its methods throw as before.
  it("throws an entrypoint's thrown error to its caller host-side, of its kind and code, with nothing of it reported", async () => {
    const run = async (route: string) => {
      const response = await fetch(new URL(route, served.url));
      return z.object({ answered: z.unknown() }).parse(await response.json())
        .answered;
    };
    const thrown = await run("/thrown");
    const long = await run("/thrown-long");
    const cached = await run("/thrown-cached");
    const named = await run("/thrown-named");
    const once = await run("/loaded-once");
    await sleep(SETTLE_MS);

    expect({
      thrown,
      long,
      cached,
      named,
      once,
      reported: served.logs().includes("record-value-c40b"),
    }).toStrictEqual({
      thrown: {
        kind: "TypeError",
        code: "app.failed",
        length: "record-value-c40b".length,
        start: "record-value-c40b",
      },
      long: {
        kind: "TypeError",
        code: "app.failed",
        length: maxThrownMessage,
        start: "record-value-c40brecord-value-c4",
      },
      cached: {
        first: {
          kind: "TypeError",
          code: "app.failed",
          length: "record-value-c40b".length,
          start: "record-value-c40b",
        },
        second: {
          kind: "TypeError",
          code: "app.failed",
          length: "record-value-c40b".length,
          start: "record-value-c40b",
        },
      },
      named: { kind: "other", code: "undefined", length: 5, start: "named" },
      once: [1, 2],
      reported: false,
    });
  });

  // The other ways a call's answer or its throw could reach workerd, each
  // answered inside the call (the security review of GRA-939): a getter in
  // the answer, a constructor's throw, a method that is a throwing
  // accessor. An answer of the call's own never reads as a thrown error,
  // whatever its keys, and a thrown error's details cross with it.
  it("answers each other way a call could throw inside the call, with nothing of it reported", async () => {
    const run = async (route: string) => {
      const response = await fetch(new URL(route, served.url));
      return z.object({ answered: z.unknown() }).parse(await response.json())
        .answered;
    };
    const thrown = {
      kind: "TypeError",
      message: "record-value-c40b",
      details: null,
    };
    const answers = {
      getter: await run("/thrown-getter"),
      construction: await run("/thrown-constructor"),
      accessor: await run("/thrown-accessor"),
      hostile: await run("/answer-hostile"),
      details: await run("/thrown-details"),
      polluted: await run("/thrown-polluted"),
      fetched: await run("/fetch-polluted"),
      fetchThrown: await run("/fetch-polluted-thrown"),
      notResponse: await run("/fetch-not-response"),
      proxied: await run("/thrown-proxied"),
      context: await run("/polluted-context"),
      listener: await run("/polluted-listener"),
    };
    // The same isolates loaded as they are: each way is read.
    const loud: Record<string, boolean> = {};
    for (const route of [
      "getter",
      "constructor",
      "accessor",
      "details",
      "polluted",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time, so each one's output is its own
      await run(`/loud/thrown-${route}`);
      // oxlint-disable-next-line no-await-in-loop -- as above
      await sleep(SETTLE_MS);
      loud[route] = served.logs().includes(`loud-${route}-c40b`);
    }
    await sleep(SETTLE_MS);

    expect({
      ...answers,
      loud,
      reported: served.logs().includes("record-value-c40b"),
    }).toStrictEqual({
      loud: {
        getter: true,
        constructor: true,
        accessor: true,
        details: true,
        polluted: true,
      },
      getter: thrown,
      construction: thrown,
      accessor: thrown,
      hostile: {
        answered: {
          "\u0000grasp:answer": true,
          thrown: { name: "TypeError", message: "forged" },
        },
      },
      details: { ...thrown, details: { retryAfterMs: 5 } },
      polluted: thrown,
      fetched: { answered: "hi" },
      fetchThrown: thrown,
      notResponse: {
        kind: "TypeError",
        message: "This fetch didn't answer a Response.",
        details: null,
      },
      proxied: thrown,
      context: { answered: true },
      listener: { answered: "done" },
      reported: false,
    });
  });

  // App code has no Node.js (`isolateBase`: `nodejs_compat` is the default
  // from 2026-08-04 on, so it is turned off): a timer imported by name from
  // `node:timers`, whose callback's throw nothing loaded first can catch,
  // can't be had. Core's own code that needs Node turns it on, and its
  // named timers are still reported: pinned so a change is seen (GRA-939).
  it("loads no App code that imports node:timers, and still reports a named timer's throw in core's own Node code", async () => {
    const refused = await fetch(new URL("/app-node-timers", served.url));
    const named = await fetch(new URL("/path/nodeNamedSetTimeout", served.url));
    const namedValue = z
      .object({ answered: z.string() })
      .parse(await named.json()).answered;
    await sleep(SETTLE_MS);

    expect({
      refused: z.object({ answered: z.unknown() }).parse(await refused.json())
        .answered,
      named: served.logs().includes(namedValue),
    }).toStrictEqual({ refused: "refused", named: true });
  });

  // Each way an isolate's code can have workerd report an error with its
  // message: the same isolate loaded as it is reports it, which shows the
  // path is read; silenced, it reports nothing.
  it.each([
    ["setImmediate", ""],
    ["nodeSetTimeout", ""],
    ["nodeSetImmediate", ""],
    ["waitUntil", ""],
    // Only `no_nodejs_compat` set: `node:timers` is still there.
    ["nodeSetTimeout", "-half"],
  ])(
    "prints nothing an isolate's %s leaves uncaught (%s), where the isolate loaded as it is does",
    async (name, half) => {
      const run = async (route: string) => {
        const response = await fetch(new URL(route, served.url));
        return z.object({ answered: z.string() }).parse(await response.json())
          .answered;
      };
      const quiet = await run(`/path${half}/${name}`);
      const loud = await run(`/loud-path${half}/${name}`);
      await sleep(SETTLE_MS);

      expect({
        answered: [quiet, loud],
        quiet: served.logs().includes(quiet),
        loud: served.logs().includes(loud),
      }).toStrictEqual({
        answered: [`quiet-${name}${half}-6d1f`, `loud-${name}${half}-6d1f`],
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
