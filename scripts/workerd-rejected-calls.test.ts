/**
 * App code that throws in a Loader isolate of core's own, on plain workerd
 * (apps/core/test/workerd/rejected-call-worker.ts): the isolate's request
 * ends once the call rejected, while core goes on. Held, it never ends, and
 * workerd aborts it as hung (cloudflare/workerd#7637), which the Worker
 * tests showed as stray "had hung" reports. What the App threw stays out of
 * workerd's log, served `--verbose` as it is.
 */
import { setTimeout as delay } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { bundle } from "./workerd-stand-in.ts";
import { cleanUp, serveOnWorkerd, tempDir } from "./workerd-test-server.ts";
import type { Served } from "./workerd-test-server.ts";

/** Long past when workerd would report the isolate's request as hung. */
const isolateEndMs = 2000;

describe("App code that throws in core's own isolate, on plain workerd", () => {
  let served: Served;

  beforeAll(async () => {
    const out = tempDir();
    const modules = bundle(out, "rejected-call-worker.ts");
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
    (name = "RUNTIME_PROFILE", text = "workerd"),
    (name = "SANDBOX_IN_PROCESS", text = "unbounded"),
    (name = "LOADER", workerLoader = ()),
  ],
);
`,
      // The loader is experimental in workerd, and a request aborted as
      // hung is logged at info level only.
      ["--experimental", "--verbose"]
    );
  }, 120_000);

  afterAll(() => {
    cleanUp();
  });

  it("ends the isolate's request once its call rejected, while core goes on", async () => {
    const response = await fetch(new URL("/call", served.url));

    await expect(response.text()).resolves.toBe("The App's code refused.");
    // workerd reports a held isolate as hung once the request that called
    // it ends: given time to, it reports none. The App's error itself is
    // kept out of the log (quiet-loader.ts), so the log can't mark the
    // isolate's end.
    await delay(isolateEndMs);
    expect(served.logs()).not.toContain("had hung");
    expect(served.logs()).not.toContain("The App's code refused.");
  });
});
