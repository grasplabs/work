import {
  appFunctionPath,
  pageLeaseHeader,
  pagePersonHeader,
} from "@grasp-os/shared/pages";
import { routerSecretHeader } from "@grasp-os/shared/router";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appKind, draftDefinition } from "../src/apps.ts";
import { readCache, writeCache } from "../src/build-cache.ts";
import { callDraftOn, draftRelease } from "../src/draft-runs.ts";
import { draftSealKey } from "../src/draft-seals.ts";
import { filesOf } from "../src/drafts.ts";
import type { DraftState } from "../src/drafts.ts";
import { decideDependency } from "../src/packages/requests.ts";
import { resolveDependencies } from "../src/packages/resolve.ts";
import { appCodeAndTestFiles } from "../src/pages.ts";
import { testApp } from "./app-definitions.ts";
import { mockIdp } from "./idp.ts";
import { named, publish, reportToOsv, rescannedUntil } from "./npm.ts";
import { livePushes, notesFiles, previewDraftsOf } from "./preview-drafts.ts";
import {
  outcome,
  previewCall,
  previewLease,
  previewOf,
  previewWatch,
} from "./previews.ts";
import { appWith } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { coreOrigin } from "./sign-in.ts";

// A draft App sealed once for what decides it (draft-seals.ts): by its
// preview object, for every caller, and kept in R2, signed. Two asks in
// this one isolate share nothing but the object and R2, as two isolates
// do. The sandbox is counted, and held where a test needs a seal under
// way, at its inspection of the draft's code, the one step of a seal no
// cache answers.

const idp = mockIdp();
const { setUp } = previewDraftsOf(idp);

/** The sandbox's inspections of App code since it was counted, and a hold on the first. */
interface Sandbox {
  readonly inspections: () => number;
  /** Answers once the first inspection reached the sandbox. */
  readonly reached: () => Promise<void>;
  /** Lets a held inspection go on. */
  readonly release: () => void;
}

/**
 * Runs `test` with the sandbox's inspections counted, the first held
 * until `release` when `hold`: in every isolate of the test's runtime,
 * the preview object's included. Released and put back however it ends.
 * The test and the object each look at the other's progress on timers
 * of their own, never awaiting the other's promise, which would carry
 * the rest of one on in the other's context.
 */
const withSandbox = async <T>(
  { hold = false }: { hold?: boolean },
  test: (sandbox: Sandbox) => Promise<T>
): Promise<T> => {
  const { LOADER: loader } = env;
  const state = { inspections: 0, released: false };
  env.LOADER = {
    // Unnamed: an isolate of the sandbox's, its code read as it starts.
    get: (name, code) =>
      loader.get(
        name,
        name === null
          ? async () => {
              const worker = await code();
              if (Object.hasOwn(worker.modules, "grasp-inspect.js")) {
                state.inspections += 1;
                if (hold && state.inspections === 1) {
                  while (!state.released) {
                    // oxlint-disable-next-line no-await-in-loop -- one look after the other
                    await scheduler.wait(5);
                  }
                }
              }
              return worker;
            }
          : code
      ),
    load: (code) => loader.load(code),
  };
  try {
    return await test({
      inspections: () => state.inspections,
      reached: async () => {
        await vi.waitFor(
          () => {
            expect(state.inspections).toBeGreaterThan(0);
          },
          { timeout: 120_000 }
        );
      },
      release: () => {
        state.released = true;
      },
    });
  } finally {
    state.released = true;
    env.LOADER = loader;
  }
};

/** What App `app`'s preview object is asked to seal of `draft`, as its callers ask. */
const sealOf = async (app: Fixture["app"], draft: DraftState) => {
  const held = await draftDefinition(env, app, draft);
  if (held === null) {
    throw new Error("The draft holds nothing to seal.");
  }
  return {
    version: (draft.base ?? 0) + 1,
    files: appCodeAndTestFiles(
      Object.fromEntries(await filesOf(env, appKind, app, draft))
    ),
    definition: held.definition,
  };
};

/** Restarts App `app`'s preview object, as a deploy does. */
const restart = async (app: Fixture["app"]): Promise<void> => {
  await runInDurableObject(previewOf(app), (_instance, state) => {
    state.abort("Restarted by the test");
  }).catch(() => {
    // Aborting fails the call that aborted: that is the restart.
  });
};

/**
 * App `app`'s draft as its preview shows it, sealed nowhere: the seal its
 * last change started (drafts.ts `draftRevised`) waited for, then taken
 * out of R2, and the preview object restarted, as when a seal was never
 * made or was swept. This isolate never sealed it as a caller.
 */
const unsealed = async (app: Fixture["app"]) => {
  const draft = await previewOf(app).draft();
  const seal = await sealOf(app, draft);
  const key = await draftSealKey(env, { app, ...seal });
  await previewOf(app)
    .seal(seal)
    .catch(() => "the draft's own failure");
  await env.FILES.delete(key);
  await restart(app);
  return { draft, seal, key };
};

/** A Notes App of a new builder's, released, its draft sealed nowhere. */
const notes = async () => {
  const fixture = await appWith(notesFiles(crypto.randomUUID()), "Notes");
  return { ...fixture, ...(await unsealed(fixture.app)) };
};

/** What the test reads of a sealed draft's entry (draft-seals.ts). */
const entrySchema = z.looseObject({
  manifestHash: z.string(),
  artifacts: z.record(z.string(), z.string()),
});

/** The code of what `run` threw, or what it answered. */
const codeOf = async (run: Promise<unknown>): Promise<unknown> => {
  try {
    return await run;
  } catch (error) {
    return z.object({ code: z.string() }).parse(error).code;
  }
};

/** A call of the notes' titles, as a page sends it. */
const titles = JSON.stringify({
  reference: { name: "notes.titles", kind: "query" },
  args: {},
});

describe("a draft's seal", { timeout: 180_000 }, () => {
  it("is made as the draft changes, so a call of it seals nothing", async () => {
    const { builder, app, revision, write } = await setUp();
    const lease = await previewLease(builder, app);
    await write(
      {
        "server/notes.ts":
          notesFiles(crypto.randomUUID()).files["server/notes.ts"] ?? "",
      },
      revision
    );
    const seal = await sealOf(app, await previewOf(app).draft());
    const key = await draftSealKey(env, { app, ...seal });
    // Nobody asked for it: the write did.
    await vi.waitFor(
      async () => {
        await expect(readCache(env, key)).resolves.toBeDefined();
      },
      { timeout: 120_000 }
    );

    const { called, inspections } = await withSandbox({}, async (sandbox) => ({
      called: outcome(await previewCall(builder, app, titles, lease)),
      inspections: sandbox.inspections(),
    }));

    expect({ called, inspections }).toStrictEqual({
      called: [],
      inspections: 0,
    });
  });

  it("is made once for every caller that asks at once", async () => {
    const { app, draft } = await notes();

    const { hashes, inspections } = await withSandbox({}, async (sandbox) => {
      const sealed = await Promise.all([
        draftRelease(env, app, draft),
        draftRelease(env, app, draft),
      ]);
      return {
        hashes: new Set(sealed.map((release) => release?.manifestHash)).size,
        inspections: sandbox.inspections(),
      };
    });

    expect({ hashes, inspections }).toStrictEqual({
      hashes: 1,
      inspections: 1,
    });
  });

  it("goes on when the call that asked for it is cancelled, for the next to read", async () => {
    const { builder, app, revision, write } = await setUp();
    const lease = await previewLease(builder, app);
    await write(
      {
        "server/notes.ts":
          notesFiles(crypto.randomUUID()).files["server/notes.ts"] ?? "",
      },
      revision
    );
    await unsealed(app);

    const { cancelled, after, inspections } = await withSandbox(
      { hold: true },
      async (sandbox) => {
        // A page's call, through the Worker as a frame sends it, whose
        // caller gives up while the seal it started inspects the code.
        const caller = new AbortController();
        const asked = exports.default
          .fetch(`${coreOrigin}${appFunctionPath}/${app}`, {
            method: "POST",
            headers: {
              origin: clientOrigin,
              "content-type": "application/json",
              cookie: builder.session,
              [pagePersonHeader]: builder.userId,
              [pageLeaseHeader]: lease,
              [routerSecretHeader]: env.ROUTER_SECRET,
            },
            body: titles,
            signal: caller.signal,
          })
          .then(
            () => "answered",
            () => "cancelled"
          );
        await sandbox.reached();
        caller.abort();
        const gaveUp = await asked;
        sandbox.release();
        return {
          cancelled: gaveUp,
          after: outcome(await previewCall(builder, app, titles, lease)),
          inspections: sandbox.inspections(),
        };
      }
    );

    expect({ cancelled, after, inspections }).toStrictEqual({
      cancelled: "cancelled",
      after: [],
      inspections: 1,
    });
  });

  it("lets a live query go while it is under way, never pushing that as final, and answers it once sealed", async () => {
    const { builder, app, revision, write } = await setUp();
    const lease = await previewLease(builder, app);
    await write(
      {
        "server/notes.ts":
          notesFiles(crypto.randomUUID()).files["server/notes.ts"] ?? "",
      },
      revision
    );
    const { key } = await unsealed(app);

    const { held, after } = await withSandbox(
      { hold: true },
      async (sandbox) => {
        const during = livePushes();
        await previewWatch(builder, app, titles, during.push, lease);
        await sandbox.reached();
        // Past the read's own deadline (query-subscriptions.ts, 30 s).
        await scheduler.wait(31_000);
        sandbox.release();
        await vi.waitFor(
          async () => {
            await expect(readCache(env, key)).resolves.toBeDefined();
          },
          { timeout: 60_000 }
        );
        // Followed again, as the page does once its query was let go.
        const again = livePushes();
        await previewWatch(builder, app, titles, again.push, lease);
        await again.until((latest) => {
          expect(latest?.result).toStrictEqual({ ok: true, value: [] });
        });
        return {
          held: during.pushed.map(({ result }) => result),
          after: again.pushed.at(-1)?.result,
        };
      }
    );

    expect({ held, after }).toStrictEqual({
      held: [],
      after: { ok: true, value: [] },
    });
  });

  it("is read back from R2 once the object that made it restarted, sealing nothing", async () => {
    const { app, draft, seal } = await notes();
    const made = await previewOf(app).seal(seal);
    await restart(app);

    const { release, kept, inspections } = await withSandbox(
      {},
      async (sandbox) => ({
        release: await draftRelease(env, app, draft),
        kept: await previewOf(app).seal(seal),
        inspections: sandbox.inspections(),
      })
    );

    expect({
      same:
        release?.manifestHash ===
        entrySchema.parse(JSON.parse(made)).manifestHash,
      kept: kept === made,
      inspections,
    }).toStrictEqual({ same: true, kept: true, inspections: 0 });
  });

  it("is made again by the next call once the object restarted under it", async () => {
    const { app, draft, key } = await notes();

    const { release, inspections } = await withSandbox(
      { hold: true },
      async (sandbox) => {
        const asked = draftRelease(env, app, draft);
        await sandbox.reached();
        // Its seal is cut short: the call is made again, of the object as
        // it wakes, and nothing of the first seal was kept.
        await restart(app);
        sandbox.release();
        const sealed = await asked;
        return { release: sealed, inspections: sandbox.inspections() };
      }
    );

    expect({
      app: release?.manifest.resourceId,
      inspections,
      kept: (await readCache(env, key)) !== undefined,
    }).toStrictEqual({ app, inspections: 2, kept: true });
  });

  it("answers a page's call by its deadline as still being prepared, and serves the next once sealed", async () => {
    const { owner, app } = await notes();

    const { first, next, inspections } = await withSandbox(
      { hold: true },
      async (sandbox) => {
        const early = await callDraftOn(env, owner, app, titles, {
          deadline: Date.now() + 100,
        });
        await sandbox.reached();
        sandbox.release();
        const later = await callDraftOn(env, owner, app, titles, {
          deadline: Date.now() + 60_000,
        });
        return {
          first: outcome(early),
          next: outcome(later),
          inspections: sandbox.inspections(),
        };
      }
    );

    expect({ first, next, inspections }).toStrictEqual({
      first: "version.seal_slow",
      next: [],
      inspections: 1,
    });
  });

  it("of a draft whose code throws as it registers is made once, however many calls and live queries ask", async () => {
    const { builder, app, revision, write } = await setUp();
    const lease = await previewLease(builder, app);
    await write(
      {
        "server/notes.ts": `${notesFiles("throws").files["server/notes.ts"] ?? ""}\nthrow new Error("The notes don't register.");\n`,
      },
      revision
    );
    await unsealed(app);

    const { answers, inspections } = await withSandbox({}, async (sandbox) => {
      const live = livePushes();
      await previewWatch(builder, app, titles, live.push, lease);
      const burst = await Promise.all(
        Array.from({ length: 5 }, async () =>
          outcome(await previewCall(builder, app, titles, lease))
        )
      );
      await live.until((latest) => {
        expect(latest?.result).toMatchObject({ ok: false });
      });
      const watched = z
        .object({ error: z.object({ code: z.string() }) })
        .parse(live.pushed.at(-1)?.result).error.code;
      const again = outcome(await previewCall(builder, app, titles, lease));
      return {
        answers: new Set([...burst, again, watched]),
        inspections: sandbox.inspections(),
      };
    });

    expect({ answers: [...answers], inspections }).toStrictEqual({
      answers: ["version.inspection_failed"],
      inspections: 1,
    });
  });

  it("is sealed by its caller while the App's preview object is of the release before, which can't", async () => {
    const { app, draft, key } = await notes();
    const { APP_PREVIEWS: previews } = env;
    // An object of the release before: it has no `seal`.
    env.APP_PREVIEWS = new Proxy(previews, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (property === "getByName" && typeof value === "function") {
          return (name: string): unknown =>
            new Proxy(Reflect.apply(value, target, [name]), {
              get: (stub, method): unknown => {
                const answered: unknown = Reflect.get(stub, method);
                return method === "seal"
                  ? async (): Promise<never> => {
                      await Promise.resolve();
                      throw new TypeError(
                        'The RPC receiver does not implement the method "seal".'
                      );
                    }
                  : answered;
              },
            });
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });

    let sealed: Awaited<ReturnType<typeof draftRelease>>;
    let inspections: number;
    try {
      ({ sealed, inspections } = await withSandbox({}, async (sandbox) => ({
        sealed: await draftRelease(env, app, draft),
        inspections: sandbox.inspections(),
      })));
    } finally {
      env.APP_PREVIEWS = previews;
    }

    expect({
      app: sealed?.manifest.resourceId,
      inspections,
      // Kept nowhere: that release keeps no seal.
      kept: await readCache(env, key),
    }).toStrictEqual({ app, inspections: 1, kept: undefined });
  });

  it("kept in R2 but changed is never run: it is sealed again in its place", async () => {
    const evil = "globalThis.changed = true;";
    /**
     * What a Notes App's draft runs once `change` changed its kept seal
     * (`entry`, its text changed to run `evil`), and how often it was
     * inspected; and what is kept after.
     */
    const changedThen = async (
      change: (key: string, changed: string) => Promise<void>
    ) => {
      const { app, draft, seal, key } = await notes();
      const made = await previewOf(app).seal(seal);
      const entry = entrySchema.parse(JSON.parse(made));
      const [sha256, code] = Object.entries(entry.artifacts).find(([, text]) =>
        text.includes("titles")
      ) ?? ["", ""];
      await change(
        key,
        JSON.stringify({
          ...entry,
          artifacts: { ...entry.artifacts, [sha256]: `${code}\n${evil}` },
        })
      );
      return await withSandbox({}, async (sandbox) => {
        await restart(app);
        const release = await draftRelease(env, app, draft);
        return {
          ran: Object.values(release?.modules ?? {}).some((module) =>
            module.includes(evil)
          ),
          inspections: sandbox.inspections(),
          kept: (await readCache(env, key)) === made,
        };
      });
    };

    // Changed in the bucket, under the MAC of what core wrote.
    const forged = await changedThen(async (key, changed) => {
      const stored = await env.FILES.get(key);
      const mac = stored?.customMetadata?.mac ?? "";
      await stored?.body.cancel();
      await env.FILES.put(key, changed, { customMetadata: { mac } });
    });
    // Changed, and signed as core signs: a byte its manifest's hash refuses.
    const signed = await changedThen(async (key, changed) => {
      await writeCache(env, key, changed);
    });

    expect({ forged, signed }).toStrictEqual({
      forged: { ran: false, inspections: 1, kept: true },
      signed: { ran: false, inspections: 1, kept: true },
    });
  });
});

/** Server code importing `server`, a package of npm's: its arithmetic. */
const packagedFiles = (server: string) =>
  testApp(
    { name: "Sums" },
    {
      "server/sums.ts": `import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";
import { double } from ${JSON.stringify(server)};

export const doubled = query({
  args: { n: v.number() },
  returns: v.number(),
  handler: async (_ctx, args) => double(args.n),
});
`,
    }
  );

/** A package for server code: arithmetic. */
const maths = async (): Promise<string> => {
  const name = named("maths");
  await publish({
    name,
    version: "1.0.0",
    manifest: { type: "module", main: "index.js", license: "MIT" },
    files: { "index.js": "export const double = (n) => n * 2;" },
  });
  return name;
};

/** `packages` asked for App `fixture` by its builder, and approved by them. */
const approved = async ({ owner, app }: Fixture, packages: string[]) => {
  const request = await resolveDependencies(env, owner, {
    app,
    purpose: "Double the numbers.",
    dependencies: packages.map((name) => ({ name, range: "^1.0.0" })),
  });
  await decideDependency(env, owner, request.id, {
    approved: true,
    graphHash: request.graphHash,
  });
  return request;
};

describe("a draft's seal of an App with packages", { timeout: 180_000 }, () => {
  it("is made again for a new approval, and never runs a revoked one", async () => {
    const server = await maths();
    const fixture = await appWith(packagedFiles(server), "Sums");
    const first = await approved(fixture, [server]);
    const { app } = fixture;
    const sealed = await draftRelease(env, app, await previewOf(app).draft());
    // The same packages and another: a graph of its own.
    const other = await maths();
    const second = await approved(fixture, [server, other]);
    const { draft } = await unsealed(app);

    const { resealed, again, inspections } = await withSandbox(
      {},
      async (sandbox) => ({
        resealed: await draftRelease(env, app, draft),
        again: await draftRelease(env, app, draft),
        inspections: sandbox.inspections(),
      })
    );
    const keyNow = async (): Promise<string> =>
      await draftSealKey(env, { app, ...(await sealOf(app, draft)) });
    const bundling = (await readCache(env, await keyNow())) ?? "";
    await reportToOsv(server, "1.0.0", "MAL-2026-50002");
    await rescannedUntil(second.id, new Date());
    // Revoked, it is no approval: the draft's code, sealed again, can't
    // import it.
    const unapproved = await codeOf(draftRelease(env, app, draft));
    // A seal that bundles it, kept under the key of the App as it is now,
    // loads, and is refused all the same.
    await writeCache(env, await keyNow(), bundling);
    const revoked = await codeOf(draftRelease(env, app, draft));

    expect({
      graphs: first.graphHash === second.graphHash,
      resealed: resealed?.manifestHash === sealed?.manifestHash,
      again: again?.manifestHash === resealed?.manifestHash,
      inspections,
      unapproved,
      revoked,
    }).toStrictEqual({
      graphs: false,
      resealed: false,
      again: true,
      inspections: 1,
      unapproved: "version.build_failed",
      revoked: "dependency.revoked",
    });
  });
});
