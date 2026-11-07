import { sha256Hex } from "@grasp-os/shared/encoding";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import {
  appFunctionPath,
  pageLeaseHeader,
  pageLimits,
  pagePersonHeader,
} from "@grasp-os/shared/pages";
import type { PageBundle } from "@grasp-os/shared/pages";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { findApp } from "../src/apps.ts";
import { callMaxNested } from "../src/call-limits.ts";
import { classifyOutput } from "../src/data-policy-rpc.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { appDefinition } from "./app-definitions.ts";
import { published } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  appModulesOf,
  kitModulesOf,
  loadFrame,
  modulePartsOf,
} from "./page-frames.ts";
import { calledAs, person as actingAs } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// Whether an App's data reaches code, taken from the side of the code that
// wants it. A page core built and leased gets it with nobody's approval,
// a new build of a new version too: it runs sandboxed, with no network,
// and reaches only its App's functions as its viewer. What still keeps the
// data from code: its release revoked, as a call lands, a push or the next
// call; and code core didn't serve (no lease of core's, a forged or
// borrowed one), refused while the App's data
// is `sensitive`, until an admin classifies it `ordinary`, which a grant
// to the App takes back. The sample App runs for real, sealed as each
// version becomes current, and what it holds stands for a client's data.
// A page calls its functions through core's function route under its
// frame's lease (app-function-route.ts) and follows them live over its
// connection (`watchQuery`), as the page relays both.

const idp = mockIdp();

const secret = "Acme owes 4,200";

/**
 * How often a held action looks whether the test let it go: each look is
 * one of its nested calls, of which its two marks spend two and a call may
 * make `callMaxNested`. So it gives up, with its own error, before the
 * platform's limit would end it.
 */
const maxLooks = callMaxNested - 2;

/**
 * The longest a held action waits between looks, backed off up to this:
 * time for the test to do what it does meanwhile and let it go. One that
 * nobody will let go (`patient: false`) looks without waiting, so it spends
 * its looks on nested calls alone and ends with its own error long before
 * a page call's 30 seconds, however slow the runner: waited out, its
 * looks would take 24 of them.
 */
const lookCapMs = 400;

// The App, in spec 8's layout and sealed as each version becomes current:
// its notes stand for a client's data. Its actions mark each step they
// take in the store, so the test sees how far one got: what it read, and
// whether it answered. One that is held waits after its read until the
// test lets it go (`<step>: release`, marked once the test has done what
// it does meanwhile), never for a time that a slow runner could outlast.
const operationsCode = `import { AppError, v } from "@grasp-os/sdk";
import { action, mutation, query } from "@server/_generated/server";

const secret = ${JSON.stringify(secret)};

const pause = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

// Waits until \`released\` says so, looking at most \`maxLooks\` times, each
// look one nested call of the action's: a test that never lets go fails it,
// within the call's nested calls. Between looks it waits for the test to
// do what it does meanwhile, unless it isn't \`patient\`: nobody will let
// it go, so waiting would only spend the call's deadline.
const until = async (released: () => Promise<boolean>, patient = true) => {
  for (let look = 0; look < ${maxLooks}; look += 1) {
    if (await released()) {
      return;
    }
    if (patient) {
      await pause(Math.min(${lookCapMs}, 50 * 2 ** look));
    }
  }
  throw new AppError("notes.never_released", "The test never let this step go.");
};

export const read = query({
  args: {},
  returns: v.array(v.string()),
  handler: async () => [secret],
});

// The notes and every step taken so far: what a live query follows.
export const live = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => [secret, ...(await ctx.db.query("steps").take(100)).map(({ step }) => step)],
});

export const mark = mutation({
  args: { step: v.string().min(1).max(100) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("steps", args);
    return null;
  },
});

// Whether the test let \`step\` go.
export const released = query({
  args: { step: v.string().min(1).max(90) },
  returns: v.boolean(),
  handler: async (ctx, args) =>
    (await ctx.db.query("steps").take(100)).some(({ step }) => step === \`\${args.step}: release\`),
});

// Reads, says so, waits if held, says it answers, then answers what it read.
export const slow = action({
  args: { step: v.string().min(1).max(90), held: v.boolean(), patient: v.boolean().optional() },
  returns: v.array(v.string()),
  uses: [mark, released],
  handler: async (ctx, args) => {
    const notes = [secret];
    await ctx.runMutation(mark, { step: \`\${args.step}: read\` });
    if (args.held) {
      await until(async () => await ctx.runQuery(released, { step: args.step }), args.patient);
    }
    await ctx.runMutation(mark, { step: \`\${args.step}: answered\` });
    return notes;
  },
});

// Reads, says so, waits if held, then answers more than a page takes in one
// call: the answer is refused as too large, by an error in place of it.
export const big = action({
  args: { step: v.string().min(1).max(90), held: v.boolean() },
  returns: v.string(),
  uses: [mark, released],
  handler: async (ctx, args) => {
    await ctx.runMutation(mark, { step: \`\${args.step}: read\` });
    if (args.held) {
      await until(async () => await ctx.runQuery(released, { step: args.step }));
    }
    return secret.padEnd(262_084, ".");
  },
});

// Reads, says so, waits if held, then fails with what it read.
export const failing = action({
  args: { step: v.string().min(1).max(90), held: v.boolean() },
  returns: v.null(),
  uses: [mark, released],
  handler: async (ctx, args) => {
    const note = secret;
    await ctx.runMutation(mark, { step: \`\${args.step}: read\` });
    if (args.held) {
      await until(async () => await ctx.runQuery(released, { step: args.step }));
    }
    throw new AppError("notes.failed", note);
  },
});
`;

const appCode = {
  ...appDefinition({
    name: "Notes",
    tables: {
      steps: {
        fields: { step: "v.string().min(1).max(100)" },
        access: { read: "appMembers", write: "appMembers" },
      },
    },
  }),
  "server/notes.ts": operationsCode,
};

const pageOf = (
  label: string
): string => `import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { api } from "@server/_generated/api";

function Notes() {
  const notes = useQuery(api.notes.read, {});
  return <Button>${label} {notes?.length ?? 0}</Button>;
}
export const Route = createFileRoute("/")({ component: Notes });
`;

const sampleFiles = {
  ...appCode,
  "src/routes/index.tsx": pageOf("Notes"),
};

/**
 * A page that imports none of the App's references (`@server/_generated/api`): what it
 * builds to is its own code alone, the same in two Apps.
 */
const plainPageOf = (
  label: string
): string => `import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@grasp-os/ui/components/button";

function Notes() {
  return <Button>${label}</Button>;
}
export const Route = createFileRoute("/")({ component: Notes });
`;

const personApi = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personApi>>;

/** Commits `files` as the App's next version and makes it current. */
const release = async (
  builder: Person,
  app: string,
  files: Record<string, string | null>
): Promise<number> => {
  const { version } = await builder.api.apps.files.commit(
    app,
    files,
    "Release"
  );
  await builder.api.apps.versions.setCurrent(app, version);
  return version;
};

/** A new App running the sample, whose data is sensitive, as every App's is. */
const sampleApp = async (builder: Person): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Notes" });
  await published(id);
  await release(builder, id, sampleFiles);
  return id;
};

/** Classifies the App's data as `admin`, under the generation they read now. */
const classifyAs = async (
  admin: Person,
  app: string,
  output: "ordinary" | "sensitive"
): Promise<void> => {
  const { generation } = await admin.api.dataPolicy.read(app);
  await admin.api.dataPolicy.classify(app, output, generation);
};

/**
 * Makes a next version of the App current, with a page more: a frame
 * opened before still runs version 1's build, pinned to it, while the
 * App runs on. Revoking the current release stops the App itself
 * (`version.revoked`); revoking the one a frame runs stops that frame.
 */
const nextVersion = async (builder: Person, app: string): Promise<void> => {
  await release(builder, app, { "src/routes/other.tsx": plainPageOf("Other") });
};

/** Revokes the release of `version` of `app`, as an admin does. */
const revoked = async (app: string, version = 1): Promise<void> => {
  await revokeRelease(
    env,
    await actingAs("admin"),
    { app: appIdSchema.parse(app), version },
    "Leaks data"
  );
};

/** Opens the page, as the page does: its lease names the build its frame runs. */
const openFrame = async (person: Person, app: string): Promise<PageBundle> =>
  await person.api.pages.open(app);

/** The lease core gives `person` opening the App's page. */
const leaseOf = async (person: Person, app: string): Promise<string> => {
  const { lease } = await openFrame(person, app);
  return lease;
};

/**
 * A call of `contractId` of `app`'s current release, as the page client
 * writes it: the reference with the release's own fingerprint, so a
 * refusal is for who calls and as which build, never for the request.
 */
const requestFor = async (
  app: string,
  contractId: string,
  input: unknown,
  idempotencyKey?: string
): Promise<string> => {
  const id = appIdSchema.parse(app);
  const { currentVersion } = await findApp(env, id);
  if (currentVersion === null) {
    throw new Error("The App has no current version");
  }
  // Its kind as the current release declares it, a query's for a name it
  // doesn't have: a page names a function by its name and kind alone.
  const released = await loadRelease(env, id, currentVersion);
  const kind = released.app.operations[contractId]?.kind ?? "query";
  return JSON.stringify({
    reference: { name: contractId, kind },
    input,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });
};

/**
 * What `person`'s page gets calling `contractId` of `app` as the build
 * `lease` names (none: no lease of core's), through core's function
 * route as the page relays it: the function's result, or the refusal's
 * code thrown, as the page rejects it.
 */
const called = async (
  person: Person,
  app: string,
  {
    lease,
    contractId = "notes.read",
    input = {},
    key,
  }: {
    lease?: string;
    contractId?: string;
    input?: unknown;
    /**
     * The idempotency key a page's session client sends every mutation
     * and action with: an action under one runs in its own invocation
     * (app-function-route.ts), checked before it runs and before its
     * answer as an unkeyed call is.
     */
    key?: string;
  } = {}
): Promise<unknown> => {
  const response = await routed(`${appFunctionPath}/${app}`, {
    method: "POST",
    headers: {
      origin: clientOrigin,
      "content-type": "application/json",
      cookie: person.session,
      [pagePersonHeader]: person.userId,
      ...(lease === undefined ? {} : { [pageLeaseHeader]: lease }),
    },
    body: await requestFor(app, contractId, input, key),
  });
  const answer: unknown = await response.json();
  if (response.ok) {
    return z.object({ result: z.unknown() }).parse(answer).result;
  }
  const { code, message } = errorPayloadSchema.parse(answer);
  throw Object.assign(new Error(message), { code });
};

/** What the App holds, as its page gets it. */
const data = { ok: true, value: [secret] };

const pushSchema = z.object({
  result: z.union([
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
  ]),
});

/** What a live query of the App's pushed: its values, and its refusals. */
const follower = () => {
  const values: unknown[] = [];
  const refused: string[] = [];
  const callback = (push: unknown): void => {
    const { result } = pushSchema.parse(push);
    if (result.ok) {
      values.push(result.value);
    } else {
      refused.push(result.error.code);
    }
  };
  return { values, refused, callback };
};

/**
 * A live query's refusal of a revoked release, recorded by whichever
 * check meets it first: its read (`admission`) or the push of what it
 * read (`push`).
 */
const liveRefusal = /^watchQuery\/(?:admission|push): revoked$/u;

/** How long a push may take to arrive, and how often to look. */
const pushWait = { timeout: 20_000, interval: 50 };

/**
 * A live query of the App's notes, from a frame `person` opened (or one
 * with no lease of core's, `unleased`), once its first read was pushed:
 * what it is pushed afterwards.
 */
const following = async (person: Person, app: string, unleased = false) => {
  const lease = unleased ? "" : await leaseOf(person, app);
  const live = follower();
  await person.api.pages
    .frame(app, lease)
    .watchQuery(await requestFor(app, "notes.live", {}), live.callback);
  await vi.waitFor(() => {
    expect(live.values).toStrictEqual([[secret]]);
  }, pushWait);
  return live;
};

/** Whether the App's steps include `step`, read past any page's gate. */
const tookStep = async (
  person: Person,
  app: string,
  step: string
): Promise<boolean> => {
  const result = await calledAs(await person.api.whoami(), app, {
    name: "notes.live",
    kind: "query",
  });
  return result.ok && JSON.stringify(result.value).includes(step);
};

/** Lets the App's held action go on past `step`: the test did what it does meanwhile. */
const letGo = async (
  person: Person,
  app: string,
  step: string
): Promise<void> => {
  const marked = await calledAs(
    await person.api.whoami(),
    app,
    { name: "notes.mark", kind: "mutation" },
    { step: `${step}: release` }
  );
  if (!marked.ok) {
    throw new Error(`The App didn't take the release of ${step}`);
  }
};

/** The refusals among `events`, as what was refused where. */
const refusals = (events: Awaited<ReturnType<typeof auditedDuring>>) =>
  events
    .filter(({ action }) => action === "app.artifact.refused")
    .map(
      ({ detail }) => `${detail.operation}/${detail.stage}: ${detail.reason}`
    );

const failedResult = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string() }),
});

/**
 * What a call failed with, its function's error or a refusal, and whether
 * anything in it carries the App's data.
 */
const failureOf = async (
  call: Promise<unknown>
): Promise<{ code: unknown; carriesData: boolean }> => {
  try {
    const result = await call;
    const failed = failedResult.safeParse(result);
    return {
      code: failed.success ? failed.data.error.code : "ok",
      carriesData: JSON.stringify(result).includes(secret),
    };
  } catch (error) {
    const seen = JSON.stringify({
      error,
      message: error instanceof Error ? error.message : undefined,
    });
    return {
      code:
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : String(error),
      carriesData: seen.includes(secret),
    };
  }
};

/** Runs `run` with the clock stopped, which `advance` moves on. */
const atStoppedClock = async <T>(
  run: (advance: (ms: number) => void) => Promise<T>
): Promise<T> => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  try {
    return await run((ms) => {
      vi.setSystemTime(Date.now() + ms);
    });
  } finally {
    vi.useRealTimers();
  }
};

describe("page delivery", { timeout: 60_000 }, () => {
  it("serves a made-current version's build and answers its functions, with no admin's approval, a new version's too", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);

    let first: PageBundle | undefined;
    let firstAnswer: unknown;
    const events = await auditedDuring(async () => {
      first = await openFrame(builder, app);
      firstAnswer = await called(builder, app, { lease: first.lease });
    });
    if (first === undefined) {
      throw new Error("The page opened");
    }
    const frame = await loadFrame(first);
    if (frame === null) {
      throw new Error("An opened page has a frame");
    }
    // A new version whose page is other code: served as it is current.
    await release(builder, app, { "src/routes/index.tsx": pageOf("Send") });
    const second = await openFrame(builder, app);

    expect({
      firstAnswer,
      delivery: await builder.api.pages.frame(app, first.lease).delivery(),
      // The lease names the hash of everything the frame runs, as core
      // serves it to the frame: its modules, the kit's it loads, its CSS,
      // built for production. Its modules' imports of each other carry
      // the frame's token as core serves them, which is no part of it.
      leasedIsWhatRuns:
        first.artifact ===
        (await sha256Hex(
          canonicalJson({
            profile: "production",
            code: {
              entry: frame.entry,
              runtime: frame.page.runtime,
              modules: Object.fromEntries(
                appModulesOf(frame).map((name) => [
                  name,
                  frame.modules[name]?.replaceAll(
                    new URL(frame.page.entry).search,
                    ""
                  ),
                ])
              ),
              addresses: Object.fromEntries(
                appModulesOf(frame).map((name) => [
                  name,
                  modulePartsOf(frame.addresses[name] ?? "").hash,
                ])
              ),
              kit: kitModulesOf(frame),
              css: frame.page.css,
            },
          })
        )),
      second: {
        version: second.version,
        otherBuild: second.artifact !== first.artifact,
        answer: await called(builder, app, { lease: second.lease }),
      },
      // The frame opened on version 1 is answered by the version current now.
      firstFrameAfter: await called(builder, app, { lease: first.lease }),
      refused: refusals(events),
    }).toStrictEqual({
      firstAnswer: data,
      delivery: "open",
      leasedIsWhatRuns: true,
      second: { version: 2, otherBuild: true, answer: data },
      firstFrameAfter: data,
      refused: [],
    });
  });

  it("answers a frame's calls with the version current now, whatever lease it keeps from the one before", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const first = await openFrame(builder, app);
    // Version 2 answers `read` with other code.
    await release(builder, app, {
      "server/notes.ts": operationsCode.replace(
        "handler: async () => [secret],",
        'handler: async () => ["version 2"],'
      ),
    });
    const replayed = await called(builder, app, { lease: first.lease });
    // Version 3 takes `read` out of its API, and its page no longer reads it.
    await release(builder, app, {
      "server/notes.ts": operationsCode
        .replace(
          "import { action, mutation, query }",
          "import { action, internalQuery, mutation, query }"
        )
        .replace(
          "export const read = query(",
          "export const read = internalQuery("
        ),
      "src/routes/index.tsx": plainPageOf("Notes"),
    });
    expect({
      replayed,
      gone: await called(builder, app, { lease: first.lease }),
    }).toMatchObject({
      replayed: { ok: true, value: ["version 2"] },
      gone: { ok: false, error: { code: "operation.not_found" } },
    });
  });

  it("decides on the build core leased the person, whatever a caller presents", async () => {
    const builder = await personApi("builder");
    const other = await personApi("builder");
    const leased = await sampleApp(builder);
    const target = await sampleApp(builder);
    await builder.api.apps.members.add(leased, {
      type: "person",
      id: other.userId,
      role: "user",
    });
    const real = await builder.api.pages.open(leased);
    // A lease is `hash.version.mac`.
    const mac = real.lease.split(".")[2] ?? "";

    const forgeries: Record<string, string> = {
      "another App's lease": real.lease,
      "a served hash, unsigned": `${real.artifact}.${real.version}.${"A".repeat(43)}`,
      "a served hash alone": real.artifact,
      "a made-up hash, with a real MAC": `${"0".repeat(64)}.${real.version}.${mac}`,
      "a trust flag": "approved",
      "nothing at all": "",
    };
    const presented: Record<string, unknown> = {};
    for (const [name, lease] of Object.entries(forgeries)) {
      // One connection each, as separate pages would.
      // oxlint-disable-next-line no-await-in-loop -- one forgery at a time
      const forger = await openRpc(builder.session);
      const api = forger.core.authenticate();
      presented[name] = [
        // oxlint-disable-next-line no-await-in-loop -- see above
        await api.pages.frame(target, lease).delivery(),
        // The same lease on the page's call of a function.
        // oxlint-disable-next-line no-await-in-loop -- see above
        await outcome(called(builder, target, { lease })),
      ];
    }
    // Someone else's lease names a build core leased the builder: for
    // anyone else it says nothing, while their own does.
    const borrowed = [
      await other.api.pages.frame(leased, real.lease).delivery(),
      await outcome(called(other, leased, { lease: real.lease })),
    ];
    const own = await openFrame(other, leased);
    const withOwn = [
      await called(other, leased, { lease: own.lease }),
      // Past the gate, to a decision there isn't.
      await outcome(
        other.api.pages
          .frame(leased, own.lease)
          .reviewDecision("run-1", "review", { approved: true })
      ),
    ];
    // A forgery of their own lease names no build, whatever another frame
    // of theirs runs.
    const forged = other.api.pages.frame(
      leased,
      `${own.artifact}.${own.version}.forged`
    );
    const afterForgery = [
      await forged.delivery(),
      await outcome(
        forged.reviewDecision("run-1", "review", { approved: true })
      ),
    ];
    // The builder's real lease, changed only in the version it was opened
    // on, or in the two-part form leases had before they signed the
    // version: neither names a build.
    const reshaped: Record<string, unknown> = {};
    for (const [name, lease] of Object.entries({
      "another version, with the real MAC": `${real.artifact}.${real.version + 1}.${mac}`,
      "the two-part form, with the real MAC": `${real.artifact}.${mac}`,
    })) {
      // oxlint-disable-next-line no-await-in-loop -- one forgery at a time
      const forger = await openRpc(builder.session);
      const api = forger.core.authenticate();
      reshaped[name] = [
        // oxlint-disable-next-line no-await-in-loop -- see above
        await api.pages.frame(leased, lease).delivery(),
        // oxlint-disable-next-line no-await-in-loop -- see above
        await outcome(called(builder, leased, { lease })),
      ];
    }
    const unchanged = await builder.api.pages
      .frame(leased, real.lease)
      .delivery();

    const refusedAsUnserved = ["unreviewed", "page.unreviewed"];
    expect({
      presented,
      borrowed,
      withOwn,
      afterForgery,
      reshaped,
      unchanged,
    }).toStrictEqual({
      presented: Object.fromEntries(
        Object.keys(forgeries).map((name) => [name, refusedAsUnserved])
      ),
      borrowed: refusedAsUnserved,
      withOwn: [data, "decision.not_found"],
      afterForgery: refusedAsUnserved,
      reshaped: {
        "another version, with the real MAC": refusedAsUnserved,
        "the two-part form, with the real MAC": refusedAsUnserved,
      },
      unchanged: "open",
    });
  });

  it("decides a lease only for the App core signed it for, the same build served in another", async () => {
    const builder = await personApi("builder");
    const plainApp = async (): Promise<string> => {
      const { id } = await builder.api.apps.create({ name: "Notes" });
      await published(id);
      await release(builder, id, {
        ...appCode,
        "src/routes/index.tsx": plainPageOf("Notes"),
      });
      return id;
    };
    const first = await plainApp();
    const second = await plainApp();
    const inFirst = await builder.api.pages.open(first);
    const inSecond = await builder.api.pages.open(second);

    expect({
      sameBuild: inFirst.artifact === inSecond.artifact,
      borrowed: await outcome(
        called(builder, second, { lease: inFirst.lease })
      ),
      own: await called(builder, second, { lease: inSecond.lease }),
    }).toStrictEqual({
      sameBuild: true,
      borrowed: "page.unreviewed",
      own: data,
    });
  });

  it("stops at a release's revocation: the answer of a call it lands in, the next push and the next call", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const bundle = await openFrame(builder, app);
    const live = follower();
    await builder.api.pages
      .frame(app, bundle.lease)
      .watchQuery(await requestFor(app, "notes.live", {}), live.callback);
    // Its first read in before anything changes, so what it is pushed is
    // known exactly.
    await vi.waitFor(() => {
      expect(live.values).toStrictEqual([[secret]]);
    }, pushWait);
    await nextVersion(builder, app);

    let answered: string[] = [];
    let opened = "";
    const events = await auditedDuring(async () => {
      // The App reads the data and says so, which the page is pushed;
      // the release is revoked while it waits, before it answers.
      const slow = outcome(
        called(builder, app, {
          lease: bundle.lease,
          contractId: "notes.slow",
          input: { step: "slow", held: true },
        })
      );
      await vi.waitFor(() => {
        expect(live.values.at(-1)).toStrictEqual([secret, "slow: read"]);
      }, pushWait);
      await revoked(app);
      // Revoked: only now does the App go on past its read.
      await letGo(builder, app, "slow");
      answered = [
        await slow,
        await outcome(called(builder, app, { lease: bundle.lease })),
        await outcome(
          builder.api.pages
            .frame(app, bundle.lease)
            .reviewDecision("run-1", "review", { approved: true })
        ),
      ];
      // The App's current version, whose release stands, opens.
      opened = await outcome(builder.api.pages.open(app));
      // What the App changed reaches the page as the refusal, never as
      // its data.
      await vi.waitFor(() => {
        expect(live.refused).toStrictEqual(["page.revoked"]);
      }, pushWait);
    });

    expect({
      answered,
      opened,
      pushed: live.values,
      delivery: await builder.api.pages.frame(app, bundle.lease).delivery(),
      refused: refusals(events).toSorted(),
    }).toStrictEqual({
      answered: ["page.revoked", "page.revoked", "page.revoked"],
      opened: "ok",
      // Nothing it read after the revocation.
      pushed: [[secret], [secret, "slow: read"]],
      delivery: "revoked",
      refused: [
        // The answer of the call it landed in, after the call ran.
        "call/admission: revoked",
        "call/delivery: revoked",
        "reviewDecision/admission: revoked",
        // The live read after the change, or its push: whichever checked
        // first.
        expect.stringMatching(liveRefusal),
      ],
    });
  });

  it("ends a build's live query when the release it runs is revoked, with nothing written after", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const live = await following(builder, app);
    await nextVersion(builder, app);
    const events = await auditedDuring(async () => {
      await revoked(app);
      await vi.waitFor(() => {
        expect(live.refused).toStrictEqual(["page.revoked"]);
      }, pushWait);
    });
    expect({ pushed: live.values, refused: refusals(events) }).toStrictEqual({
      pushed: [[secret]],
      refused: ["watchQuery/push: revoked"],
    });
  });

  it("refuses a build of a revoked release however its App's data is classified", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const bundle = await openFrame(builder, app);
    await nextVersion(builder, app);
    await revoked(app);
    await classifyAs(admin, app, "ordinary");

    expect({
      delivery: await builder.api.pages.frame(app, bundle.lease).delivery(),
      call: await outcome(called(builder, app, { lease: bundle.lease })),
      // Code core didn't serve calls the current version, which stands.
      unleased: await outcome(called(builder, app)),
    }).toStrictEqual({
      delivery: "revoked",
      call: "page.revoked",
      unleased: "ok",
    });
  });

  it("hands a page no error of its App's once its release is revoked: the error carries what the App read", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const bundle = await openFrame(builder, app);

    // Before, the App's own message reaches the page, and with it what
    // the App read.
    const before = await failureOf(
      called(builder, app, {
        lease: bundle.lease,
        contractId: "notes.failing",
        input: { step: "before", held: false },
      })
    );
    await nextVersion(builder, app);
    let after: Awaited<ReturnType<typeof failureOf>> | undefined;
    const events = await auditedDuring(async () => {
      // The App reads, the release is revoked, then the App fails.
      const failing = failureOf(
        called(builder, app, {
          lease: bundle.lease,
          contractId: "notes.failing",
          input: { step: "revoked", held: true },
        })
      );
      await vi.waitFor(async () => {
        await expect(
          tookStep(builder, app, "revoked: read")
        ).resolves.toBeTruthy();
      }, pushWait);
      await revoked(app);
      await letGo(builder, app, "revoked");
      after = await failing;
    });

    expect({ before, after, refused: refusals(events) }).toStrictEqual({
      before: { code: "notes.failed", carriesData: true },
      after: { code: "page.revoked", carriesData: false },
      // After the call ran: its error, not the call, was withheld.
      refused: ["call/delivery: revoked"],
    });
  });

  it("withholds the answer of an action sent under a key once its release is revoked as it runs", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const bundle = await openFrame(builder, app);
    await nextVersion(builder, app);
    const key = crypto.randomUUID();

    let answered: unknown;
    const events = await auditedDuring(async () => {
      const running = called(builder, app, {
        lease: bundle.lease,
        contractId: "notes.slow",
        input: { step: "keyed", held: true },
        key,
      });
      await vi.waitFor(async () => {
        await expect(
          tookStep(builder, app, "keyed: read")
        ).resolves.toBeTruthy();
      }, pushWait);
      await revoked(app);
      await letGo(builder, app, "keyed");
      answered = await running;
    });

    const withheld = z
      .object({
        ok: z.literal(false),
        error: z.object({ code: z.string(), details: z.unknown() }),
      })
      .safeParse(answered);
    expect({
      answered: withheld.success
        ? {
            code: withheld.data.error.code,
            details: withheld.data.error.details,
          }
        : answered,
      carriesData: JSON.stringify(answered).includes(secret),
      refused: refusals(events),
    }).toStrictEqual({
      // It ran, so whether it finished is withheld, with the key that
      // recovers it, and why: never its answer.
      answered: {
        code: "submission.outcome_unknown",
        details: { idempotencyKey: key, refusal: "page.revoked" },
      },
      carriesData: false,
      refused: ["call/delivery: revoked"],
    });
  });

  it("ends a held action nobody lets go with its own error, within its nested calls", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const bundle = await openFrame(builder, app);

    // Every look spent, never let go: the action's own error, never the
    // platform's limit on nested calls or the call's deadline. Nobody lets
    // it go, so it looks without waiting between looks (`patient: false`).
    const failed = await failureOf(
      called(builder, app, {
        lease: bundle.lease,
        contractId: "notes.slow",
        input: { step: "never", held: true, patient: false },
      })
    );

    expect({
      failed,
      read: await tookStep(builder, app, "never: read"),
    }).toStrictEqual({
      failed: { code: "notes.never_released", carriesData: false },
      read: true,
    });
  });

  it("runs no action sent under a key without a lease of core's", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);

    let unleased = "";
    const events = await auditedDuring(async () => {
      unleased = await outcome(
        called(builder, app, {
          contractId: "notes.slow",
          input: { step: "unleased", held: false },
          key: crypto.randomUUID(),
        })
      );
    });
    const ranUnleased = await tookStep(builder, app, "unleased: read");
    // The same call from the page core leased, under a key of its own, runs.
    const bundle = await openFrame(builder, app);
    const leased = await called(builder, app, {
      lease: bundle.lease,
      contractId: "notes.slow",
      input: { step: "leased", held: false },
      key: crypto.randomUUID(),
    });

    expect({
      unleased,
      ranUnleased,
      refused: refusals(events),
      leased,
    }).toStrictEqual({
      unleased: "page.unreviewed",
      // Refused before it ran: nothing of it was marked.
      ranUnleased: false,
      refused: ["call/admission: unreviewed"],
      leased: data,
    });
  });

  it("opens an App whose data an admin classified as ordinary to code core didn't serve, until they take that back", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);

    let ordinary: unknown[] = [];
    const events = await auditedDuring(async () => {
      await classifyAs(admin, app, "ordinary");
      // Said again: nothing changes, and nothing is recorded.
      await classifyAs(admin, app, "ordinary");
      ordinary = [
        await called(builder, app),
        await builder.api.pages.frame(app, "").delivery(),
      ];
      await classifyAs(admin, app, "sensitive");
    });

    expect({
      ordinary,
      sensitiveAgain: await outcome(called(builder, app)),
      // A page core leased is served either way.
      leased: await called(builder, app, {
        lease: await leaseOf(builder, app),
      }),
      classified: events
        .filter(({ action }) => action === "app.output.classified")
        .map(({ actor, target, detail }) => ({ actor, target, detail })),
    }).toStrictEqual({
      ordinary: [data, "open"],
      sensitiveAgain: "page.unreviewed",
      leased: data,
      classified: [
        {
          actor: { type: "person", userId: admin.userId },
          target: { type: "app", id: app },
          detail: { output: "ordinary", previous: "sensitive" },
        },
        {
          actor: { type: "person", userId: admin.userId },
          target: { type: "app", id: app },
          detail: { output: "sensitive", previous: "ordinary" },
        },
      ],
    });
  });

  it("ends a live query of code core didn't serve when its App's data is sensitive again, with nothing written after", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    await classifyAs(admin, app, "ordinary");
    const live = await following(builder, app, true);
    const events = await auditedDuring(async () => {
      await classifyAs(admin, app, "sensitive");
      await vi.waitFor(() => {
        expect(live.refused).toStrictEqual(["page.unreviewed"]);
      }, pushWait);
    });
    expect({ pushed: live.values, refused: refusals(events) }).toStrictEqual({
      pushed: [[secret]],
      refused: ["watchQuery/push: unreviewed"],
    });
  });

  it("is classified only by one of the organization's own admins, who still is one as it lands", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const user = await personApi("user");
    const app = await sampleApp(builder);
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = core.authenticate();
    const { generation } = await admin.api.dataPolicy.read(app);

    const byOthers = await Promise.all(
      [builder.api, user.api, staff].map(
        async (api) =>
          await outcome(api.dataPolicy.classify(app, "ordinary", generation))
      )
    );
    // The identity the session check hands over while they are an admin:
    // the check reads the role again on every call, so the only way in
    // between it and the write is to call past it with that identity.
    const checked = await admin.api.whoami();
    await env.DB.prepare("UPDATE members SET role = 'user' WHERE user_id = ?")
      .bind(admin.userId)
      .run();
    let demoted = "";
    const events = await auditedDuring(async () => {
      demoted = await outcome(
        classifyOutput(env, checked, app, "ordinary", generation)
      );
    });
    const second = await personApi("admin");
    const { output: after } = await second.api.dataPolicy.read(app);

    expect({
      byOthers,
      demoted,
      events,
      after,
    }).toStrictEqual({
      byOthers: ["role.forbidden", "role.forbidden", "role.forbidden"],
      demoted: "role.forbidden",
      events: [],
      after: "sensitive",
    });
  });

  it("classifies only under the policy the admin read: a grant in between moves it on", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const { generation: shown } = await admin.api.dataPolicy.read(app);
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Ledger ${crypto.randomUUID()}`,
      access: "everyone",
    });
    const { id: permission } = await builder.api.permissions.request({
      subject: { type: "app", appId: app },
      object: { type: "collection", collectionId },
      actions: ["read"],
      binding: "LEDGER",
    });
    await admin.api.permissions.grant(permission, { version: 1 });

    let stale = "";
    const events = await auditedDuring(async () => {
      stale = await outcome(
        admin.api.dataPolicy.classify(app, "ordinary", shown)
      );
    });
    const after = await admin.api.dataPolicy.read(app);
    const fresh = await admin.api.dataPolicy.classify(
      app,
      "ordinary",
      after.generation
    );

    expect({
      stale,
      events: events.map(({ action }) => action),
      output: after.output,
      fresh,
    }).toStrictEqual({
      stale: "page.review_outdated",
      events: [],
      output: "sensitive",
      fresh: "ordinary",
    });
  });

  it("grants an App more only by an admin, and makes its ordinary data sensitive again in the grant's batch", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const user = await personApi("user");
    const app = await sampleApp(builder);
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Ledger ${crypto.randomUUID()}`,
      access: "everyone",
    });
    const request = {
      subject: { type: "app" as const, appId: app },
      object: { type: "collection" as const, collectionId },
      actions: ["read"],
      binding: "LEDGER",
    };
    await classifyAs(admin, app, "ordinary");
    const { generation: before } = await admin.api.dataPolicy.read(app);
    const opened = await outcome(called(builder, app));
    const { id: permission } = await builder.api.permissions.request(request);
    // Nobody but an admin grants it: not the App's builder, nor anyone
    // else, and asking leaves the data as it was.
    const byOthers = [
      await outcome(builder.api.permissions.grant(permission, { version: 1 })),
      await outcome(user.api.permissions.grant(permission, { version: 1 })),
    ];
    const whileRequested = await admin.api.dataPolicy.read(app);
    const events = await auditedDuring(async () => {
      await admin.api.permissions.grant(permission, { version: 1 });
    });
    const after = await admin.api.dataPolicy.read(app);
    // Granted more while sensitive: nothing to say again.
    const { id: second } = await builder.api.permissions.request({
      ...request,
      binding: "LEDGER_AGAIN",
    });
    const quiet = await auditedDuring(async () => {
      await admin.api.permissions.grant(second, { version: 1 });
    });

    expect({
      opened,
      byOthers,
      whileRequested: whileRequested.output,
      events: events.map(({ action, actor, detail }) => ({
        action,
        actor,
        detail: action === "app.output.classified" ? detail : undefined,
      })),
      output: after.output,
      // A classification read before the grant no longer lands.
      generationMoved: after.generation > before,
      refused: await outcome(called(builder, app)),
      // The page core leased is served still.
      leased: await called(builder, app, {
        lease: await leaseOf(builder, app),
      }),
      quiet: quiet.map(({ action }) => action),
    }).toStrictEqual({
      opened: "ok",
      byOthers: ["role.forbidden", "role.forbidden"],
      whileRequested: "ordinary",
      events: [
        {
          action: "permission.granted",
          actor: { type: "person", userId: admin.userId },
          detail: undefined,
        },
        {
          action: "app.output.classified",
          actor: { type: "person", userId: admin.userId },
          detail: {
            output: "sensitive",
            previous: "ordinary",
            grantedTo: app,
            permission,
          },
        },
      ],
      output: "sensitive",
      generationMoved: true,
      refused: "page.unreviewed",
      leased: data,
      quiet: ["permission.granted"],
    });
  });

  it("makes ordinary data sensitive again for the granted App, and for no App that doesn't reach it", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    // Apart reaches nothing of Granted. What reaches it through an app
    // resource isn't followed yet (GRA-954).
    const [granted, apart] = await Promise.all([
      sampleApp(builder),
      sampleApp(builder),
    ]);
    await Promise.all(
      [granted, apart].map(async (app) => {
        await classifyAs(admin, app, "ordinary");
      })
    );
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Ledger ${crypto.randomUUID()}`,
      access: "everyone",
    });

    let permission = "";
    const events = await auditedDuring(async () => {
      ({ id: permission } = await builder.api.permissions.request({
        subject: { type: "app", appId: granted },
        object: { type: "collection", collectionId },
        actions: ["read"],
        binding: "LEDGER",
      }));
      await admin.api.permissions.grant(permission, { version: 1 });
    });
    const outputs = await Promise.all(
      [granted, apart].map(async (app) => {
        const { output } = await admin.api.dataPolicy.read(app);
        return output;
      })
    );

    expect({
      outputs,
      classified: events
        .filter(({ action }) => action === "app.output.classified")
        .map(({ actor, target, detail }) => ({
          actor,
          app: target?.id,
          detail,
        })),
    }).toStrictEqual({
      outputs: ["sensitive", "ordinary"],
      classified: [
        {
          actor: { type: "person", userId: admin.userId },
          app: granted,
          detail: {
            output: "sensitive",
            previous: "ordinary",
            grantedTo: granted,
            permission,
          },
        },
      ],
    });
  });

  it("counts a call as a request, and records the same refusal once a while", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);

    const { calls, events, later } = await atStoppedClock(async (advance) => {
      const tried: string[] = [];
      const recorded = await auditedDuring(async () => {
        for (
          let attempt = 0;
          attempt <= pageLimits.requests.burst;
          attempt += 1
        ) {
          // oxlint-disable-next-line no-await-in-loop -- one call after another, as a page retrying
          tried.push(await outcome(called(builder, app)));
        }
      });
      // Long after: the same refusal is recorded again, once.
      advance(60 * 60_000);
      const again = await auditedDuring(async () => {
        await outcome(called(builder, app));
        await outcome(called(builder, app));
      });
      return { calls: tried, events: recorded, later: again };
    });

    expect({
      unreviewed: calls.filter((code) => code === "page.unreviewed").length,
      limited: calls.filter((code) => code === "page.rate_limited").length,
      refused: refusals(events),
      later: refusals(later),
    }).toStrictEqual({
      unreviewed: pageLimits.requests.burst,
      limited: 1,
      refused: ["call/admission: unreviewed"],
      later: ["call/admission: unreviewed"],
    });
  });

  it("audits a refusal whose record failed to be written at its next refusal", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    // The audit outbox refuses this App's refusals for a while.
    await env.DB.prepare(
      `CREATE TRIGGER refuse_refusals BEFORE INSERT ON audit_outbox
       WHEN NEW.event LIKE '%app.artifact.refused%' AND NEW.event LIKE '%${app}%'
       BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`
    ).run();
    let failed = "";
    try {
      failed = await outcome(called(builder, app));
    } finally {
      await env.DB.prepare("DROP TRIGGER refuse_refusals").run();
    }
    const events = await auditedDuring(async () => {
      await outcome(called(builder, app));
    });

    expect({ failed, refused: refusals(events) }).toStrictEqual({
      failed: "internal.unexpected",
      refused: ["call/admission: unreviewed"],
    });
  });

  it("audits two identical refusals that arrive together once", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);

    const events = await auditedDuring(async () => {
      await Promise.all([
        outcome(called(builder, app)),
        outcome(called(builder, app)),
      ]);
    });

    expect(refusals(events)).toStrictEqual(["call/admission: unreviewed"]);
  });
});
