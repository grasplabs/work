import { EventEmitter } from "node:events";

import { describe, expect, it } from "vite-plus/test";

import {
  builtinsInstalled,
  coreStarted,
  installedOnWorkerd,
  isCoreHealth,
} from "./workerd-smoke-start.ts";
import type {
  HealthPoll,
  KnownGap,
  WorkerdProcess,
} from "./workerd-smoke-start.ts";

/** Core's own health answer, as core sends it. */
const coreHealth = (): Response =>
  Response.json({ ok: true }, { headers: { "x-request-id": "request-1" } });

/** A workerd process that exits when told to. */
// oxlint-disable-next-line unicorn/prefer-event-target -- it stands in for Node's ChildProcess, an EventEmitter
class FakeWorkerd extends EventEmitter implements WorkerdProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  exit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

/** A health poll whose every request `answer` answers. */
const pollWith = (answer: () => Promise<Response>): HealthPoll => ({
  url: "http://127.0.0.1:8790/health",
  headers: {},
  fetch: answer,
  attempts: 3,
  retryDelayMs: 0,
});

describe("the workerd smoke run", () => {
  it("takes core's own health answer", async () => {
    await expect(isCoreHealth(coreHealth())).resolves.toBeTruthy();
  });

  it("refuses another server's 200, without core's request ID or with another body", async () => {
    const answers = [
      Response.json({ ok: true }),
      Response.json(
        { ok: true, registered: true },
        { headers: { "x-request-id": "request-1" } }
      ),
    ];
    await expect(
      Promise.all(answers.map(async (answer) => await isCoreHealth(answer)))
    ).resolves.toStrictEqual([false, false]);
  });

  it("fails with workerd's exit code when workerd exits before core answers", async () => {
    const workerd = new FakeWorkerd();
    // Nothing ever answers, so only the exit settles it.
    const started = coreStarted(
      workerd,
      pollWith(async () => await Promise.withResolvers<Response>().promise)
    );
    workerd.exit(1);
    await expect(started).rejects.toThrow(
      "workerd exited (1) before core answered"
    );
  });

  it("fails when another server answers first", async () => {
    await expect(
      coreStarted(
        new FakeWorkerd(),
        pollWith(async () => await Promise.resolve(Response.json({ ok: true })))
      )
    ).rejects.toThrow("something other than core answers");
  });

  it("starts once core answers, while workerd runs", async () => {
    let requests = 0;
    const poll = pollWith(async () => {
      requests += 1;
      // Not listening yet on the first request.
      if (requests === 1) {
        throw new TypeError("fetch failed");
      }
      return await Promise.resolve(coreHealth());
    });
    await expect(coreStarted(new FakeWorkerd(), poll)).resolves.toBeUndefined();
  });
});

/** A line workerd writes with `structuredLogging` for a console call. */
const logged = (level: string, message: string): string =>
  JSON.stringify({ timestamp: 1, level, message });

/** As workerd prints core's `log.info("builtins.installed", ...)`. */
const installed = (outcome: string): string =>
  logged("info", `{ event: 'builtins.installed', outcome: '${outcome}' }`);

/** As workerd prints a blueprint core failed to install. */
const blueprintFailed = (
  errorMessage: string,
  thrownIn = "storeBlueprintTree"
): string =>
  logged(
    "error",
    `{\n  event: 'builtins.blueprint_failed',\n  blueprint: 'intake',\n  errorName: 'TypeError',\n  errorMessage: ${JSON.stringify(errorMessage)},\n  errorStack: ${JSON.stringify(`TypeError: ${errorMessage}\\n`)} +\n    '    at ${thrownIn} (index.js:183943:20)\\n' +\n    '    at async installBlueprints (index.js:192662:7)'\n}`
  );

const filesGap: KnownGap = {
  event: "builtins.blueprint_failed",
  errorMessage: "Cannot read properties of undefined (reading 'put')",
  thrownIn: "storeBlueprintTree",
  why: "FILES has no on-prem service",
};

/** workerd's output when nothing more is ever logged. */
const silent = (): AsyncIterable<string> => ({
  [Symbol.asyncIterator]: () => ({
    next: async () =>
      await Promise.withResolvers<IteratorResult<string>>().promise,
  }),
});

describe("the workerd smoke run's install check", () => {
  it("passes once the built-ins install completely, past other logs and warnings", async () => {
    await expect(
      builtinsInstalled(
        [
          logged("info", "{ event: 'request', status: 200 }"),
          logged("warn", "service core: nodejs_compat is the default"),
          installed("complete"),
        ],
        []
      )
    ).resolves.toStrictEqual([]);
  });

  it("fails when a blueprint fails to install", async () => {
    await expect(
      builtinsInstalled(
        [blueprintFailed("D1_ERROR: no such table"), installed("partial")],
        [filesGap]
      )
    ).rejects.toThrow("core logged a failure on workerd");
  });

  it("fails when the install fails as a whole", async () => {
    await expect(
      builtinsInstalled(
        [
          logged(
            "error",
            "{ event: 'builtins.install_failed', errorName: 'TypeError' }"
          ),
        ],
        [filesGap]
      )
    ).rejects.toThrow("builtins.install_failed");
  });

  it("fails on a partial install no known gap explains", async () => {
    await expect(
      builtinsInstalled([installed("partial")], [filesGap])
    ).rejects.toThrow("built-in content installed partial");
  });

  it("fails on an error workerd itself writes, or any *_failed event", async () => {
    const failures = [
      "workerd/util/sqlite.c++:645: error: unable to open database file",
      logged("warn", "{ event: 'skills.sync_failed', reason: 'conflict' }"),
    ];
    await expect(
      Promise.allSettled(
        failures.map(
          async (line) =>
            await builtinsInstalled([line, installed("complete")], [])
        )
      )
    ).resolves.toMatchObject([{ status: "rejected" }, { status: "rejected" }]);
  });

  it("excuses a known gap's exact failure, and names it", async () => {
    await expect(
      builtinsInstalled(
        [
          blueprintFailed(filesGap.errorMessage),
          blueprintFailed(filesGap.errorMessage),
          installed("partial"),
        ],
        [filesGap]
      )
    ).resolves.toStrictEqual([filesGap]);
  });

  it("doesn't excuse a known gap's error thrown somewhere else", async () => {
    await expect(
      builtinsInstalled(
        [
          blueprintFailed(filesGap.errorMessage, "installBuiltinBlueprint"),
          installed("partial"),
        ],
        [filesGap]
      )
    ).rejects.toThrow("core logged a failure on workerd");
  });

  it("fails when workerd exits before the built-ins are installed", async () => {
    const workerd = new FakeWorkerd();
    // Nothing is ever logged, so only the exit settles it.
    const installing = installedOnWorkerd(workerd, silent(), [], 60_000);
    workerd.exit(1);
    await expect(installing).rejects.toThrow(
      "workerd exited (1) before the built-ins were installed"
    );
  });

  it("fails when the built-ins aren't installed in time", async () => {
    await expect(
      installedOnWorkerd(new FakeWorkerd(), silent(), [], 10)
    ).rejects.toThrow("weren't installed within 10 ms");
  });
});
