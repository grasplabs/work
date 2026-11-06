import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { withDraftReferences } from "../src/draft-references.ts";
import { buildOnSave } from "../src/save-builds.ts";
import { appDefinition } from "./app-definitions.ts";

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

/** A screen no one built yet: unique, so no build of it is cached. */
const freshScreen = (): Record<string, string> => ({
  "screens/fresh.tsx": `export default function Fresh() {\n  return <main>${crypto.randomUUID()}</main>;\n}\n`,
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
            files: freshScreen(),
          },
          { profile: "production", signal: lost() }
        )
    );
    expect(watched).toStrictEqual({
      outcome: lostLease.message,
      // Nothing written: no compile ran. (The cache read is its receipt in
      // core's database: with none, no object is read.)
      touched: [],
    });
  });

  it("starts no compile for a screen's references when it is given up on during their cache read", async () => {
    const giveUp = new AbortController();
    const touched: string[] = [];
    const { FILES: files, DB: db } = env;
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
    // Its lease lost while the references' manifest was read from the
    // cache: its receipt, in core's database (build-cache.ts).
    env.DB = new Proxy(db, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (property === "prepare" && typeof value === "function") {
          return (query: string): unknown => {
            if (
              query.includes("build_receipts") &&
              query.startsWith("select")
            ) {
              touched.push("receipt");
              giveUp.abort(lostLease);
            }
            return Reflect.apply(value, target, [query]);
          };
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    const app = appIdSchema.parse(crypto.randomUUID());
    let outcome: string;
    try {
      await withDraftReferences(
        env,
        app,
        0,
        {
          // The App layout, its screen importing its references, its code
          // new, so nothing of it is cached.
          ...appDefinition({ name: `Desk ${crypto.randomUUID()}` }),
          "screens/desk.tsx":
            'import { references } from "@server/_generated/api";\nexport default () => String(references);\n',
        },
        { signal: giveUp.signal }
      );
      outcome = "ran to its end";
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error);
    } finally {
      env.FILES = files;
      env.DB = db;
    }
    expect({
      outcome,
      read: touched.includes("receipt"),
      compiled: touched.includes("put"),
    }).toStrictEqual({
      outcome: lostLease.message,
      read: true,
      compiled: false,
    });
  });
});
