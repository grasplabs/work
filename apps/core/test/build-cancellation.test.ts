import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { buildOnSave } from "../src/save-builds.ts";
import { isolateCall, workflowTestOutcome } from "../src/workflows/code.ts";

// A build job's check given up on once its lease is lost (build-
// admission.ts, `holding`): what it builds and tests starts nothing more,
// gives up the test it runs, and throws why, rather than report a build
// or a test as the code's failure. Core's files and the workflow sandbox
// are real; core's files are watched to see what the check touched.

/** Why the tests give up: a build job's step lost its lease. */
const lostLease = new Error("The build job's step lost its lease");

/** A signal aborted already, as a lost lease leaves it. */
const lost = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort(lostLease);
  return controller.signal;
};

/**
 * Runs `run` with core's files watched: the methods it called on them, in
 * order. Set back afterwards.
 */
const watchingFiles = async (
  run: () => Promise<unknown>
): Promise<{ outcome: string; touched: string[] }> => {
  const touched: string[] = [];
  const { FILES: files } = env;
  env.FILES = new Proxy(files, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (typeof property === "string" && typeof value === "function") {
        return async (...args: unknown[]): Promise<unknown> => {
          touched.push(property);
          return await Reflect.apply(value, target, args);
        };
      }
      return value;
    },
  });
  try {
    await run();
    return { outcome: "ran to its end", touched };
  } catch (error) {
    return {
      outcome: error instanceof Error ? error.message : String(error),
      touched,
    };
  } finally {
    env.FILES = files;
  }
};

/** Server code no one built yet: unique, so no build of it is cached. */
const freshServer = (): Record<string, string> => ({
  "app/server.ts": `export const built = ${JSON.stringify(crypto.randomUUID())};\n`,
});

describe("a build given up on", { timeout: 60_000 }, () => {
  it("starts no compile once given up on, and throws why rather than report a failed build", async () => {
    const watched = await watchingFiles(
      async () =>
        await buildOnSave(
          env,
          {
            app: appIdSchema.parse(crypto.randomUUID()),
            version: 0,
            files: freshServer(),
          },
          lost()
        )
    );
    expect(watched).toStrictEqual({
      outcome: lostLease.message,
      // Its cache read, and nothing written: no compile ran.
      touched: ["get"],
    });
  });

  it("builds nothing for workflow tests once given up on", async () => {
    const watched = await watchingFiles(
      async () =>
        await workflowTestOutcome(
          env,
          appIdSchema.parse(crypto.randomUUID()),
          0,
          {
            "workflows/intake.ts": "export default {};\n",
            "workflows/intake.test.ts": "export default [];\n",
          },
          lost()
        )
    );
    expect(watched).toStrictEqual({
      outcome: lostLease.message,
      touched: [],
    });
  });

  it("gives up a test isolate's call still running once its signal aborts", async () => {
    const giveUp = new AbortController();
    const started = Date.now();
    const call = isolateCall(env, {
      key: null,
      owner: `app-${crypto.randomUUID()}`,
      mainModule: "hang.js",
      modules: async () =>
        await Promise.resolve({
          "hang.js":
            'import { WorkerEntrypoint } from "cloudflare:workers"; export class Tests extends WorkerEntrypoint { async run() { await scheduler.wait(60000); } }',
        }),
      entrypoint: "Tests",
      method: "run",
      args: [],
      signal: giveUp.signal,
    });
    await scheduler.wait(200);
    giveUp.abort(lostLease);
    let outcome: string;
    try {
      await call;
      outcome = "answered";
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error);
    }
    expect({
      outcome,
      promptly: Date.now() - started < 5000,
    }).toStrictEqual({ outcome: lostLease.message, promptly: true });
  });

  it("never starts a test isolate given up on before its call", async () => {
    let loaded = false;
    let outcome: string;
    try {
      await isolateCall(env, {
        key: null,
        owner: `app-${crypto.randomUUID()}`,
        mainModule: "tests.js",
        modules: async () => {
          loaded = true;
          return await Promise.resolve({
            "tests.js":
              'import { WorkerEntrypoint } from "cloudflare:workers"; export class Tests extends WorkerEntrypoint { async run() { return "ran"; } }',
          });
        },
        entrypoint: "Tests",
        method: "run",
        args: [],
        signal: lost(),
      });
      outcome = "answered";
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error);
    }
    // Room for a load started anyway to land.
    await scheduler.wait(1000);
    expect({ outcome, loaded }).toStrictEqual({
      outcome: lostLease.message,
      loaded: false,
    });
  });

  it("starts no workflow compile when it is given up on during the build's cache read", async () => {
    const giveUp = new AbortController();
    const touched: string[] = [];
    const { FILES: files } = env;
    env.FILES = new Proxy(files, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (typeof property === "string" && typeof value === "function") {
          return async (...args: unknown[]): Promise<unknown> => {
            touched.push(property);
            const answer: unknown = await Reflect.apply(value, target, args);
            // Its lease lost while the build's cache was read.
            if (
              property === "get" &&
              typeof args[0] === "string" &&
              args[0].startsWith("workflow-builds/")
            ) {
              giveUp.abort(lostLease);
            }
            return answer;
          };
        }
        return value;
      },
    });
    let outcome: string;
    try {
      await workflowTestOutcome(
        env,
        appIdSchema.parse(crypto.randomUUID()),
        0,
        {
          "workflows/intake.ts": `export const built = ${JSON.stringify(crypto.randomUUID())};\n`,
          "workflows/intake.test.ts": "export default [];\n",
        },
        giveUp.signal
      );
      outcome = "ran to its end";
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error);
    } finally {
      env.FILES = files;
    }
    expect({ outcome, compiled: touched.includes("put") }).toStrictEqual({
      outcome: lostLease.message,
      compiled: false,
    });
  });
});
