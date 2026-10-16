import { sha256Hex } from "@grasp-os/shared/encoding";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Role } from "@grasp-os/shared/roles";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import {
  appFunctionPath,
  screenLeaseHeader,
  screenLimits,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import type { ScreenBundle } from "@grasp-os/shared/screens";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { findApp } from "../src/apps.ts";
import { callMaxNested } from "../src/call-limits.ts";
import {
  approveScreens,
  classifyOutput,
  revokeScreen,
} from "../src/screen-trust-rpc.ts";
import { mockIdp } from "./idp.ts";
import { appModulesOf, kitModulesOf, loadFrame } from "./screen-frames.ts";
import { calledAs } from "./sealed-apps.ts";
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

// Whether an App's data reaches a screen, taken from the side of the code
// that wants it: a screen nobody approved, which says it is approved,
// names another build's hash, borrows someone else's lease, or keeps
// asking after its approval was taken back. And from the side of whoever
// would approve without the right to, or approve something other than
// what they were shown. The sample App runs for real, sealed as each
// version becomes current, and what it holds stands for a client's data.
// A screen calls its functions through core's function route under its
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
 * The longest a held action waits between looks: its looks, backed off up
 * to this, all fit in a screen call's 30 seconds.
 */
const lookCapMs = 400;

// The App, in spec 8's layout and sealed as each version becomes current:
// its notes stand for a client's data. Its actions mark each step they
// take in the store, so the test sees how far one got: what it read, and
// whether it answered. One that is held waits after its read until the
// test lets it go (`<step>: release`, marked once the test has done what
// it does meanwhile), never for a time that a slow runner could outlast.
const operationsCode = `import { AppError, v } from "@grasp-os/sdk";
import { action, mutation, query } from "#grasp/server";

const secret = ${JSON.stringify(secret)};

const pause = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

// Waits until \`released\` says so, looking at most \`maxLooks\` times, each
// look one nested call of the action's: a test that never lets go fails it,
// well within the call's nested calls and its deadline.
const until = async (released: () => Promise<boolean>) => {
  for (let look = 0; look < ${maxLooks}; look += 1) {
    if (await released()) {
      return;
    }
    await pause(Math.min(${lookCapMs}, 50 * 2 ** look));
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
  args: { step: v.string().min(1).max(90), held: v.boolean() },
  returns: v.array(v.string()),
  uses: [mark, released],
  handler: async (ctx, args) => {
    const notes = [secret];
    await ctx.runMutation(mark, { step: \`\${args.step}: read\` });
    if (args.held) {
      await until(async () => await ctx.runQuery(released, { step: args.step }));
    }
    await ctx.runMutation(mark, { step: \`\${args.step}: answered\` });
    return notes;
  },
});

// Reads, says so, waits if held, then answers more than a screen takes in one
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
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  steps: defineTable({ step: v.string().min(1).max(100) }),
});
`,
  "operations/notes.ts": operationsCode,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { big, failing, live, mark, read, released, slow } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: { tables: { steps: { read: "appMembers", write: "appMembers" } } },
  operations: { notes: { read, live, mark, released, slow, failing, big } },
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
};

const screenOf = (
  label: string
): string => `import { useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { api } from "#grasp";

export default function Notes() {
  const notes = useQuery(api.notes.read, {});
  return <Button>${label} {notes?.length ?? 0}</Button>;
}
`;

const sampleFiles = {
  ...appCode,
  "screens/notes.tsx": screenOf("Notes"),
};

/**
 * A screen that imports none of the App's references (`#grasp`): what it
 * builds to is its own code alone. One that imports them builds them in,
 * and they name the release they belong to (screen-references.ts), so
 * each version's build is its own, and its own to approve.
 */
const plainScreenOf = (
  label: string
): string => `import { Button } from "@grasp-os/ui/components/button";

export default function Notes() {
  return <Button>${label}</Button>;
}
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
  await release(builder, id, sampleFiles);
  return id;
};

/** Approves the App's current screens as `admin`, exactly as reviewed. */
const approveCurrent = async (admin: Person, app: string) => {
  const { version, generation, screens } =
    await admin.api.screenTrust.review(app);
  return await admin.api.screenTrust.approve(app, {
    version,
    generation,
    artifacts: builtArtifacts(screens),
  });
};

/** Classifies the App's data as `admin`, under the generation they review now. */
const classifyAs = async (
  admin: Person,
  app: string,
  output: "ordinary" | "sensitive"
): Promise<void> => {
  const { generation } = await admin.api.screenTrust.review(app);
  await admin.api.screenTrust.classify(app, output, generation);
};

/** Opens the screen and presents its lease on the same connection, as the page does. */
const openFrame = async (
  person: Person,
  app: string
): Promise<ScreenBundle> => {
  const bundle = await person.api.screens.open(app, "notes");
  await person.api.screens.present(app, bundle.lease);
  return bundle;
};

/**
 * A call of `contractId` of `app`'s current release, as the screen client
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
  const released = await loadRelease(env, id, currentVersion);
  const operation = released.app.operations[contractId];
  const fingerprint = released.fingerprints[contractId];
  if (operation === undefined || fingerprint === undefined) {
    throw new Error(`The release has no ${contractId}`);
  }
  return JSON.stringify({
    reference: {
      resourceId: app,
      resourceVersion: currentVersion,
      contractId,
      fingerprint,
      kind: operation.kind,
    },
    input,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });
};

/**
 * What `person`'s screen gets calling `contractId` of `app` as the build
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
     * The idempotency key a screen's session client sends every mutation
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
      [screenPersonHeader]: person.userId,
      ...(lease === undefined ? {} : { [screenLeaseHeader]: lease }),
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

/** What the App holds, as its screen gets it. */
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
 * A live query's refusal of a build taken back, recorded by whichever
 * check meets it first: its read (`admission`) or the push of what it
 * read (`push`).
 */
const liveRefusal = /^watchQuery\/(?:admission|push): revoked$/u;

/** How long a push may take to arrive, and how often to look. */
const pushWait = { timeout: 20_000, interval: 50 };

/** Whether the App's steps include `step`, read past any screen's trust. */
const tookStep = async (
  person: Person,
  app: string,
  step: string
): Promise<boolean> => {
  const result = await calledAs(await person.api.whoami(), app, {
    contractId: "notes.live",
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
    { contractId: "notes.mark", kind: "mutation" },
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

/** Whether `app` is among what waits on `admin`. Tests share a deployment. */
const waitsOn = async (admin: Person, app: string): Promise<boolean> => {
  const waiting = await admin.api.screenTrust.waiting();
  return waiting.some(({ app: id }) => id === app);
};

const noop = (): void => {
  // Nothing to update.
};

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

describe("screen trust", { timeout: 60_000 }, () => {
  it("keeps an App's data from a screen until an admin approved exactly its build", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);

    let before: string[] = [];
    const refused = await auditedDuring(async () => {
      before = await Promise.all([
        outcome(builder.api.screens.open(app, "notes")),
        outcome(called(builder, app)),
      ]);
    });
    const all = await admin.api.screenTrust.waiting();
    const waiting = all.filter(({ app: id }) => id === app);
    const approval = await auditedDuring(async () => {
      await approveCurrent(admin, app);
    });
    const bundle = await openFrame(builder, app);
    const frame = await loadFrame(bundle);
    if (frame === null) {
      throw new Error("An opened screen has a frame");
    }

    expect({
      before,
      refused: refusals(refused).toSorted(),
      waiting: waiting.map(({ app: id, version, screens }) => ({
        id,
        version,
        screens,
      })),
      // Not for whoever can't decide.
      waitingForBuilder: await builder.api.screenTrust.waiting(),
      approval: approval.map(({ action, actor, target, detail }) => ({
        action,
        actor,
        target,
        artifact: detail.artifact,
        screen: detail.screen,
      })),
      // What is approved is the hash of everything the frame runs, as
      // core serves it to the frame: its modules, the kit's it loads, its
      // CSS.
      approvedIsWhatRuns:
        bundle.artifact ===
        (await sha256Hex(
          canonicalJson({
            entry: frame.screen.entry,
            runtime: frame.screen.runtime,
            modules: Object.fromEntries(
              appModulesOf(frame).map((name) => [name, frame.modules[name]])
            ),
            kit: kitModulesOf(frame),
            css: frame.screen.css,
          })
        )),
      after: await called(builder, app, { lease: bundle.lease }),
      stillWaiting: await waitsOn(admin, app),
    }).toStrictEqual({
      before: ["screen.unreviewed", "screen.unreviewed"],
      refused: ["call/admission: unreviewed", "open/admission: unreviewed"],
      waiting: [{ id: app, version: 1, screens: ["notes"] }],
      waitingForBuilder: [],
      approval: [
        {
          action: "app.artifact.approved",
          actor: { type: "person", userId: admin.userId },
          target: { type: "app", id: app },
          artifact: bundle.artifact,
          screen: "notes",
        },
      ],
      approvedIsWhatRuns: true,
      after: data,
      stillWaiting: false,
    });
  });

  it("decides on the build core leased the person, whatever a caller presents", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const other = await personApi("builder");
    // An approved App, and one with the same code that nobody approved.
    const approved = await sampleApp(builder);
    await approveCurrent(admin, approved);
    const unapproved = await sampleApp(builder);
    await builder.api.apps.members.add(approved, {
      type: "person",
      id: other.userId,
      role: "user",
    });
    const real = await builder.api.screens.open(approved, "notes");
    const [, mac] = real.lease.split(".");

    const forgeries: Record<string, string> = {
      // The approved App's lease, for the App nobody approved.
      "another App's lease": real.lease,
      // The same hash, which is approved over there, with a made-up MAC.
      "an approved hash, unsigned": `${real.artifact}.${"A".repeat(43)}`,
      "an approved hash alone": real.artifact,
      "a made-up hash, with a real MAC": `${"0".repeat(64)}.${mac}`,
      "a trust flag": "approved",
      "nothing at all": "",
    };
    const presented: Record<string, unknown> = {};
    for (const [name, lease] of Object.entries(forgeries)) {
      // One connection each: nothing an earlier forgery presented is left.
      // oxlint-disable-next-line no-await-in-loop -- one forgery at a time
      const forger = await openRpc(builder.session);
      const api = forger.core.authenticate();
      presented[name] = [
        // oxlint-disable-next-line no-await-in-loop -- see above
        await api.screens.present(unapproved, lease),
        // The same lease on the screen's call of a function.
        // oxlint-disable-next-line no-await-in-loop -- see above
        await outcome(called(builder, unapproved, { lease })),
      ];
    }
    // Someone else's lease on the approved App names the approved build,
    // but core signed it for the builder: for anyone else it says nothing,
    // while their own does.
    const borrowed = [
      await other.api.screens.present(approved, real.lease),
      await outcome(called(other, approved, { lease: real.lease })),
    ];
    const own = await openFrame(other, approved);
    const withOwn = [
      await called(other, approved, { lease: own.lease }),
      // Past the gate, to the run the workflow doesn't have.
      await outcome(other.api.screens.runs(approved, "invoices")),
    ];
    // A connection that presented its lease loses it to a forgery: it
    // can't keep the approved build while its frame runs something else.
    const afterForgery = [
      await other.api.screens.present(approved, `${own.artifact}.forged`),
      await outcome(other.api.screens.runs(approved, "invoices")),
    ];

    expect({ presented, borrowed, withOwn, afterForgery }).toStrictEqual({
      presented: Object.fromEntries(
        Object.keys(forgeries).map((name) => [
          name,
          ["unreviewed", "screen.unreviewed"],
        ])
      ),
      borrowed: ["unreviewed", "screen.unreviewed"],
      withOwn: [data, "ok"],
      afterForgery: ["unreviewed", "screen.unreviewed"],
    });
  });

  it("asks for a new approval when the screen's code changes, and for none when it doesn't", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const plainApp = async (): Promise<string> => {
      const { id } = await builder.api.apps.create({ name: "Notes" });
      await release(builder, id, {
        ...appCode,
        "screens/notes.tsx": plainScreenOf("Notes"),
      });
      return id;
    };
    const app = await plainApp();
    await approveCurrent(admin, app);
    const first = await openFrame(builder, app);

    // The App's functions alone: the screen builds to the same bytes.
    await release(builder, app, {
      "operations/notes.ts": `${operationsCode}\n// Changed.\n`,
    });
    const sameScreen = await builder.api.screens.open(app, "notes");
    // The screen itself: other bytes, which nobody approved.
    await release(builder, app, { "screens/notes.tsx": plainScreenOf("Send") });
    const changed = await outcome(builder.api.screens.open(app, "notes"));
    const review = await admin.api.screenTrust.review(app);
    // The frame opened before still runs what was approved.
    const oldFrame = await called(builder, app, { lease: first.lease });
    // Back to the first screen: its approval is of those bytes, whichever
    // version holds them.
    await release(builder, app, {
      "screens/notes.tsx": plainScreenOf("Notes"),
    });
    const back = await builder.api.screens.open(app, "notes");

    // The same files in another App build to the same bytes, from the
    // same cached build: that App's screen is still nobody's to trust.
    const copy = await plainApp();
    const inCopy = await outcome(builder.api.screens.open(copy, "notes"));

    // A screen that calls the App's functions builds its references in:
    // a new version of its functions is a new build to approve.
    const referencing = await sampleApp(builder);
    await approveCurrent(admin, referencing);
    await release(builder, referencing, {
      "operations/notes.ts": `${operationsCode}\n// Changed.\n`,
    });
    const newReferences = await outcome(
      builder.api.screens.open(referencing, "notes")
    );

    expect({
      sameScreen: sameScreen.artifact === first.artifact,
      changed,
      review: review.screens.map(({ screen, trust, artifact }) => ({
        screen,
        trust,
        other: artifact !== first.artifact,
      })),
      oldFrame,
      back: back.artifact === first.artifact,
      inCopy,
      newReferences,
    }).toStrictEqual({
      sameScreen: true,
      changed: "screen.unreviewed",
      review: [{ screen: "notes", trust: "unreviewed", other: true }],
      oldFrame: data,
      back: true,
      inCopy: "screen.unreviewed",
      newReferences: "screen.unreviewed",
    });
  });

  it("approves only what its admin was shown, as core builds it now", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const shown = await admin.api.screenTrust.review(app);
    const artifacts = builtArtifacts(shown.screens);
    const reviewed = { version: 1, generation: shown.generation, artifacts };

    const refused = await auditedDuring(async () => {
      await expect(
        Promise.all([
          // Hashes nobody built.
          outcome(
            admin.api.screenTrust.approve(app, {
              ...reviewed,
              artifacts: ["0".repeat(64)],
            })
          ),
          // More than the version has.
          outcome(
            admin.api.screenTrust.approve(app, {
              ...reviewed,
              artifacts: [...artifacts, "0".repeat(64)],
            })
          ),
          // A version that isn't there.
          outcome(
            admin.api.screenTrust.approve(app, { ...reviewed, version: 7 })
          ),
        ])
      ).resolves.toStrictEqual([
        "screen.review_outdated",
        "screen.review_outdated",
        "app.version_not_found",
      ]);
      // The screen changed after the review: the version reviewed still
      // builds to what was shown, and is approved; the new one isn't.
      await release(builder, app, { "screens/notes.tsx": screenOf("Send") });
      await admin.api.screenTrust.approve(app, reviewed);
      // The App's policy moved on with that approval: a review from
      // before it no longer decides anything.
      const stale = await admin.api.screenTrust.review(app);
      await expect(
        outcome(
          admin.api.screenTrust.approve(app, {
            version: stale.version,
            generation: shown.generation,
            artifacts: builtArtifacts(stale.screens),
          })
        )
      ).resolves.toBe("screen.review_outdated");
    });

    expect({
      approved: refused
        .filter(({ action }) => action === "app.artifact.approved")
        .map(({ detail }) => detail.version),
      current: await outcome(builder.api.screens.open(app, "notes")),
    }).toStrictEqual({ approved: [1], current: "screen.unreviewed" });
  });

  it("is decided only by one of the organization's own admins, who still is one as the decision lands", async () => {
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
    const shown = await admin.api.screenTrust.review(app);
    const reviewed = {
      version: shown.version,
      generation: shown.generation,
      artifacts: builtArtifacts(shown.screens),
    };
    const [artifact] = reviewed.artifacts;
    if (artifact === undefined) {
      throw new Error("The sample has a screen");
    }

    const byOthers = await Promise.all(
      [builder.api, user.api, staff].flatMap((api) => [
        outcome(api.screenTrust.approve(app, reviewed)),
        outcome(api.screenTrust.revoke(app, artifact)),
        outcome(api.screenTrust.classify(app, "ordinary", shown.generation)),
      ])
    );
    // The identity the session check hands over while they are an admin:
    // the check reads the role again on every call, so the only way in
    // between it and the write is to call past it with that identity.
    const second = await personApi("admin");
    const checked = await admin.api.whoami();
    await env.DB.prepare("UPDATE members SET role = 'user' WHERE user_id = ?")
      .bind(admin.userId)
      .run();
    const demoted: string[] = [];
    const approving = await auditedDuring(async () => {
      demoted.push(await outcome(approveScreens(env, checked, app, reviewed)));
    });
    const unapproved = await second.api.screenTrust.review(app);
    // Approved by someone who may, for the demoted admin to take back.
    await approveCurrent(second, app);
    const undoing = await auditedDuring(async () => {
      demoted.push(
        await outcome(revokeScreen(env, checked, app, artifact)),
        await outcome(
          classifyOutput(
            env,
            checked,
            app,
            "ordinary",
            unapproved.generation + 1
          )
        )
      );
    });
    const after = await second.api.screenTrust.review(app);

    expect({
      byOthers,
      demoted,
      events: [...approving, ...undoing],
      unapproved: unapproved.screens.map(({ trust }) => trust),
      after: {
        output: after.output,
        trust: after.screens.map(({ trust }) => trust),
      },
    }).toStrictEqual({
      byOthers: Array.from({ length: 9 }, () => "role.forbidden"),
      demoted: ["role.forbidden", "role.forbidden", "role.forbidden"],
      events: [],
      unapproved: ["unreviewed"],
      after: { output: "sensitive", trust: ["approved"] },
    });
  });

  it("stops at the revocation: the answer of a call it lands in, the next push and the next call", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    await approveCurrent(admin, app);
    const bundle = await openFrame(builder, app);
    const live = follower();
    await builder.api.screens.watchQuery(
      app,
      bundle.lease,
      await requestFor(app, "notes.live", {}),
      live.callback
    );
    // Its first read in before anything changes, so what it is pushed is
    // known exactly.
    await vi.waitFor(() => {
      expect(live.values).toStrictEqual([[secret]]);
    }, pushWait);

    let answered: string[] = [];
    let cachedBuild = "";
    const events = await auditedDuring(async () => {
      // The App reads the data and says so, which the screen is pushed;
      // the approval is taken back while it waits, before it answers.
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
      await admin.api.screenTrust.revoke(app, bundle.artifact);
      // Revoked: only now does the App go on past its read.
      await letGo(builder, app, "slow");
      answered = [
        await slow,
        await outcome(called(builder, app, { lease: bundle.lease })),
        await outcome(builder.api.screens.watchRuns(app, "invoices", noop)),
      ];
      // The build is still in the cache; it opens nothing.
      cachedBuild = await outcome(builder.api.screens.open(app, "notes"));
      // What the App changed as it answered reaches the screen as the
      // refusal, never as its data.
      await vi.waitFor(() => {
        expect(live.refused).toStrictEqual(["screen.revoked"]);
      }, pushWait);
    });
    const standing = await builder.api.screens.present(app, bundle.lease);
    // A screen revoked no longer waits on an admin: it was decided.
    const waiting = await waitsOn(admin, app);
    // Approved again by a person, it runs again.
    await approveCurrent(admin, app);
    const again = await called(builder, app, { lease: bundle.lease });

    expect({
      answered,
      cachedBuild,
      // It ran to its end: the answer was refused, not the run.
      answeredStep: await tookStep(builder, app, "slow: answered"),
      pushed: live.values,
      again,
      standing,
      waiting,
      revoked: events.filter(({ action }) => action === "app.artifact.revoked")
        .length,
      refused: refusals(events).toSorted(),
    }).toStrictEqual({
      answered: ["screen.revoked", "screen.revoked", "screen.revoked"],
      cachedBuild: "screen.revoked",
      answeredStep: true,
      // Nothing it read after the revocation.
      pushed: [[secret], [secret, "slow: read"]],
      again: data,
      standing: "revoked",
      waiting: false,
      revoked: 1,
      refused: [
        // The answer of the call it landed in, after the call ran.
        "call/admission: revoked",
        "call/delivery: revoked",
        "open/admission: revoked",
        // The live read after the change, or its push: whichever checked
        // first.
        expect.stringMatching(liveRefusal),
        "watchRuns/admission: revoked",
      ],
    });
  });

  it("holds every way from an App to an unapproved screen, and leaves the screen its own reports", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const { screens } = builder.api;
    const live = await requestFor(app, "notes.live", {});

    const events = await auditedDuring(async () => {
      expect({
        gated: await Promise.all([
          outcome(called(builder, app)),
          outcome(screens.watchQuery(app, "", live, noop)),
          outcome(screens.startRun(app, "invoices")),
          outcome(screens.runs(app, "invoices")),
          outcome(screens.run(app, "run-1")),
          outcome(
            screens.reviewDecision(app, "run-1", "approve", { approved: true })
          ),
          outcome(
            screens.confirmDecision(app, "run-1", "approve", "revision", {
              approved: true,
            })
          ),
          outcome(screens.decide(app, "run-1", "approve", { approved: true })),
          outcome(screens.watchRuns(app, "invoices", noop)),
        ]),
        version: await screens.version(app),
        report: await outcome(
          screens.report(
            app,
            { version: 1, screen: "notes" },
            { kind: "error", message: "It didn't load" }
          )
        ),
      }).toStrictEqual({
        gated: Array.from({ length: 9 }, () => "screen.unreviewed"),
        version: 1,
        report: "ok",
      });
    });

    expect(refusals(events).toSorted()).toStrictEqual([
      "call/admission: unreviewed",
      "confirmDecision/admission: unreviewed",
      "decide/admission: unreviewed",
      "reviewDecision/admission: unreviewed",
      "run/admission: unreviewed",
      "runs/admission: unreviewed",
      "startRun/admission: unreviewed",
      "watchQuery/admission: unreviewed",
      "watchRuns/admission: unreviewed",
    ]);
  });

  it("opens an App whose data an admin classified as ordinary to code nobody approved, until they take that back", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);

    let ordinary: unknown[] = [];
    let lease = "";
    const events = await auditedDuring(async () => {
      await classifyAs(admin, app, "ordinary");
      // Said again: nothing changes, and nothing is recorded.
      await classifyAs(admin, app, "ordinary");
      const bundle = await openFrame(builder, app);
      ({ lease } = bundle);
      ordinary = [
        await called(builder, app, { lease: bundle.lease }),
        await builder.api.screens.present(app, bundle.lease),
        // Nothing waits on an admin for it.
        await waitsOn(admin, app),
      ];
      await classifyAs(admin, app, "sensitive");
    });

    expect({
      ordinary,
      sensitiveAgain: await outcome(called(builder, app, { lease })),
      classified: events
        .filter(({ action }) => action === "app.output.classified")
        .map(({ actor, target, detail }) => ({ actor, target, detail })),
    }).toStrictEqual({
      ordinary: [data, "open", false],
      sensitiveAgain: "screen.unreviewed",
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

  it("hands a screen no error of its App's once its approval is taken back: the error carries what the App read", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    await approveCurrent(admin, app);
    const bundle = await openFrame(builder, app);

    // While approved, the App's own message reaches the screen, and with
    // it what the App read.
    const approved = await failureOf(
      called(builder, app, {
        lease: bundle.lease,
        contractId: "notes.failing",
        input: { step: "approved", held: false },
      })
    );
    let revoked: Awaited<ReturnType<typeof failureOf>> | undefined;
    const events = await auditedDuring(async () => {
      // The App reads, the approval is taken back, then the App fails.
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
      await admin.api.screenTrust.revoke(app, bundle.artifact);
      // Revoked: only now does the App go on past its read.
      await letGo(builder, app, "revoked");
      revoked = await failing;
    });

    expect({ approved, revoked, refused: refusals(events) }).toStrictEqual({
      approved: { code: "notes.failed", carriesData: true },
      revoked: { code: "screen.revoked", carriesData: false },
      // After the call ran: its error, not the call, was withheld.
      refused: ["call/delivery: revoked"],
    });
  });

  it("hands a screen no refusal of its App's answer once its approval is taken back: the refusal is the revocation", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    await approveCurrent(admin, app);
    const bundle = await openFrame(builder, app);

    // While approved, an answer too large for a screen is refused as such.
    const approved = await failureOf(
      called(builder, app, {
        lease: bundle.lease,
        contractId: "notes.big",
        input: { step: "big approved", held: false },
      })
    );
    let revoked: Awaited<ReturnType<typeof failureOf>> | undefined;
    const events = await auditedDuring(async () => {
      // The App reads, the approval is taken back, then its answer is
      // refused: the screen hears of the revocation, not of the answer.
      const answering = failureOf(
        called(builder, app, {
          lease: bundle.lease,
          contractId: "notes.big",
          input: { step: "big revoked", held: true },
        })
      );
      await vi.waitFor(async () => {
        await expect(
          tookStep(builder, app, "big revoked: read")
        ).resolves.toBeTruthy();
      }, pushWait);
      await admin.api.screenTrust.revoke(app, bundle.artifact);
      // Revoked: only now does the App go on past its read.
      await letGo(builder, app, "big revoked");
      revoked = await answering;
    });

    expect({ approved, revoked, refused: refusals(events) }).toStrictEqual({
      approved: { code: "screen.answer_too_large", carriesData: false },
      revoked: { code: "screen.revoked", carriesData: false },
      refused: ["call/delivery: revoked"],
    });
  });

  it("runs no action a screen sends under a key for a build nobody approved", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const key = crypto.randomUUID();

    let unapproved = "";
    const events = await auditedDuring(async () => {
      unapproved = await outcome(
        called(builder, app, {
          contractId: "notes.slow",
          input: { step: "unapproved", held: false },
          key,
        })
      );
    });
    const ranUnapproved = await tookStep(builder, app, "unapproved: read");
    // The same call of an approved build's, under a key of its own, runs.
    await approveCurrent(admin, app);
    const bundle = await openFrame(builder, app);
    const approved = await called(builder, app, {
      lease: bundle.lease,
      contractId: "notes.slow",
      input: { step: "approved", held: false },
      key: crypto.randomUUID(),
    });

    expect({
      unapproved,
      ranUnapproved,
      refused: refusals(events),
      approved,
    }).toStrictEqual({
      unapproved: "screen.unreviewed",
      // Refused before it ran: nothing of it was marked.
      ranUnapproved: false,
      refused: ["call/admission: unreviewed"],
      approved: data,
    });
  });

  it("withholds the answer of an action sent under a key once its approval is taken back as it runs", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    await approveCurrent(admin, app);
    const bundle = await openFrame(builder, app);
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
      await admin.api.screenTrust.revoke(app, bundle.artifact);
      // Revoked: only now does the App go on past its read.
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
        details: { idempotencyKey: key, refusal: "screen.revoked" },
      },
      carriesData: false,
      refused: ["call/delivery: revoked"],
    });
  });

  it("ends a held action nobody lets go with its own error, within its nested calls", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    await approveCurrent(admin, app);
    const bundle = await openFrame(builder, app);

    // Every look spent, never let go: the action's own error, never the
    // platform's limit on nested calls or the call's deadline.
    const failed = await failureOf(
      called(builder, app, {
        lease: bundle.lease,
        contractId: "notes.slow",
        input: { step: "never", held: true },
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

  it("decides a lease only for the App core signed it for, the same build approved in another", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const plainApp = async (): Promise<string> => {
      const { id } = await builder.api.apps.create({ name: "Notes" });
      await release(builder, id, {
        ...appCode,
        "screens/notes.tsx": plainScreenOf("Notes"),
      });
      await approveCurrent(admin, id);
      return id;
    };
    const first = await plainApp();
    const second = await plainApp();
    const inFirst = await builder.api.screens.open(first, "notes");
    const inSecond = await builder.api.screens.open(second, "notes");

    expect({
      sameBuild: inFirst.artifact === inSecond.artifact,
      borrowed: await outcome(
        called(builder, second, { lease: inFirst.lease })
      ),
      own: await called(builder, second, { lease: inSecond.lease }),
    }).toStrictEqual({
      sameBuild: true,
      borrowed: "screen.unreviewed",
      own: data,
    });
  });

  it("refuses a build whose approval was taken back, however its App's data is classified", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    await approveCurrent(admin, app);
    const bundle = await openFrame(builder, app);
    await admin.api.screenTrust.revoke(app, bundle.artifact);
    await classifyAs(admin, app, "ordinary");

    // Code nobody decided on gets ordinary data; code an admin took back
    // doesn't, on the connection it ran on or opened again.
    const copy = await sampleApp(builder);
    await classifyAs(admin, copy, "ordinary");
    expect({
      present: await builder.api.screens.present(app, bundle.lease),
      call: await outcome(called(builder, app, { lease: bundle.lease })),
      open: await outcome(builder.api.screens.open(app, "notes")),
      undecided: await outcome(builder.api.screens.open(copy, "notes")),
    }).toStrictEqual({
      present: "revoked",
      call: "screen.revoked",
      open: "screen.revoked",
      undecided: "ok",
    });
  });

  it("makes ordinary data sensitive again when the App is granted more, in the grant's batch, for an admin to decide again", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
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
    const { generation: before } = await admin.api.screenTrust.review(app);
    const opened = await outcome(called(builder, app));
    const { id: permission } = await builder.api.permissions.request(request);
    const events = await auditedDuring(async () => {
      await admin.api.permissions.grant(permission, { version: 1 });
    });
    const after = await admin.api.screenTrust.review(app);
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
      events: events.map(({ action, actor, detail }) => ({
        action,
        actor,
        detail: action === "app.output.classified" ? detail : undefined,
      })),
      output: after.output,
      // An approval reviewed before the grant no longer lands.
      generationMoved: after.generation > before,
      refused: await outcome(called(builder, app)),
      waiting: await waitsOn(admin, app),
      quiet: quiet.map(({ action }) => action),
    }).toStrictEqual({
      opened: "ok",
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
      refused: "screen.unreviewed",
      waiting: true,
      quiet: ["permission.granted"],
    });
  });

  it("counts opening a screen as a request, and records the same refusal once a while", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);

    const { opens, events, later } = await atStoppedClock(async (advance) => {
      const tried: string[] = [];
      const recorded = await auditedDuring(async () => {
        for (
          let attempt = 0;
          attempt <= screenLimits.requests.burst;
          attempt += 1
        ) {
          // oxlint-disable-next-line no-await-in-loop -- one open after another, as a page retrying
          tried.push(await outcome(builder.api.screens.open(app, "notes")));
        }
      });
      // Long after: the same refusal is recorded again, once.
      advance(60 * 60_000);
      const again = await auditedDuring(async () => {
        await outcome(builder.api.screens.open(app, "notes"));
        await outcome(builder.api.screens.open(app, "notes"));
      });
      return { opens: tried, events: recorded, later: again };
    });

    expect({
      unreviewed: opens.filter((code) => code === "screen.unreviewed").length,
      limited: opens.filter((code) => code === "screen.rate_limited").length,
      refused: refusals(events),
      later: refusals(later),
    }).toStrictEqual({
      unreviewed: screenLimits.requests.burst,
      limited: 1,
      refused: ["open/admission: unreviewed"],
      later: ["open/admission: unreviewed"],
    });
  });

  it("lets an admin read the source of each build and take back the approval of an older version's", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    await approveCurrent(admin, app);
    const first = await openFrame(builder, app);
    await release(builder, app, { "screens/notes.tsx": screenOf("Send") });
    await approveCurrent(admin, app);

    const listed = await admin.api.screenTrust.review(app);
    await admin.api.screenTrust.revoke(app, first.artifact);
    const after = await admin.api.screenTrust.review(app);
    const [firstSource, newSource] = await Promise.all([
      admin.api.screenTrust.source(app, 1),
      admin.api.screenTrust.source(app, 2),
    ]);
    const user = await personApi("user");

    expect({
      listed: listed.decided.map(({ artifact, version, trust }) => ({
        first: artifact === first.artifact,
        version,
        trust,
      })),
      after: after.decided
        .filter(({ artifact }) => artifact === first.artifact)
        .map(({ trust, decidedBy }) => ({ trust, decidedBy })),
      // The frame of the older build stops at its next call.
      oldFrame: await outcome(called(builder, app, { lease: first.lease })),
      source: Object.keys(firstSource),
      sourceOfNew: newSource["screens/notes.tsx"],
      byUser: await outcome(user.api.screenTrust.source(app, 1)),
    }).toStrictEqual({
      listed: [
        { first: false, version: 2, trust: "approved" },
        { first: true, version: 1, trust: "approved" },
      ],
      after: [{ trust: "revoked", decidedBy: admin.userId }],
      oldFrame: "screen.revoked",
      source: ["screens/notes.tsx"],
      sourceOfNew: screenOf("Send"),
      byUser: "app.not_found",
    });
  });

  it("classifies only under the policy the admin reviewed: a grant in between moves it on", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const { generation: shown } = await admin.api.screenTrust.review(app);
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
        admin.api.screenTrust.classify(app, "ordinary", shown)
      );
    });
    const after = await admin.api.screenTrust.review(app);
    const fresh = await admin.api.screenTrust.classify(
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
      stale: "screen.review_outdated",
      events: [],
      output: "sensitive",
      fresh: "ordinary",
    });
  });

  it("makes ordinary data sensitive again for every App that reaches a granted App through exports or workflows, however far", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    // Far reaches Near's exports, Near reaches Granted's workflows;
    // Apart reaches nothing.
    const [granted, near, far, apart] = await Promise.all([
      sampleApp(builder),
      sampleApp(builder),
      sampleApp(builder),
      sampleApp(builder),
    ]);
    const grantNow = async (
      request: Parameters<typeof builder.api.permissions.request>[0]
    ): Promise<string> => {
      const { id } = await builder.api.permissions.request(request);
      await admin.api.permissions.grant(id, { version: 1 });
      return id;
    };
    await grantNow({
      subject: { type: "app", appId: near },
      object: { type: "app", appId: granted },
      actions: ["read"],
      binding: "GRANTED",
    });
    await grantNow({
      subject: { type: "app", appId: far },
      object: { type: "app", appId: near },
      actions: ["read"],
      binding: "NEAR",
    });
    await Promise.all(
      [granted, near, far, apart].map(async (app) => {
        await classifyAs(admin, app, "ordinary");
      })
    );
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Ledger ${crypto.randomUUID()}`,
      access: "everyone",
    });

    let permission = "";
    const events = await auditedDuring(async () => {
      permission = await grantNow({
        subject: { type: "app", appId: granted },
        object: { type: "collection", collectionId },
        actions: ["read"],
        binding: "LEDGER",
      });
    });
    const outputs = await Promise.all(
      [granted, near, far, apart].map(async (app) => {
        const { output } = await admin.api.screenTrust.review(app);
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
        }))
        .toSorted((a, b) => String(a.app).localeCompare(String(b.app))),
    }).toStrictEqual({
      outputs: ["sensitive", "sensitive", "sensitive", "ordinary"],
      classified: [granted, near, far].toSorted().map((app) => ({
        actor: { type: "person", userId: admin.userId },
        app,
        detail: {
          output: "sensitive",
          previous: "ordinary",
          grantedTo: granted,
          permission,
        },
      })),
    });
  });

  it("puts a version in front of the admins as soon as it is current, before anyone opens it", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    // Its screen imports the App's references (`#grasp`), which name the
    // release the version was sealed with as it was made current.
    const app = await sampleApp(builder);
    // Recorded in the background as it was made current: soon after.
    const waitingNow = await vi.waitFor(async () => {
      const listed = await admin.api.screenTrust.waiting();
      const found = listed.find(({ app: id }) => id === app);
      if (found === undefined) {
        throw new Error("Not recorded yet");
      }
      return found;
    }, pushWait);
    // Recorded is not approved: the build still opens to nobody.
    const recorded = await outcome(builder.api.screens.open(app, "notes"));
    await approveCurrent(admin, app);
    const afterApproval = await waitsOn(admin, app);
    // What waited is what runs: approved, it opens.
    const approved = await outcome(builder.api.screens.open(app, "notes"));
    await release(builder, app, { "screens/notes.tsx": screenOf("Send") });
    const nextVersion = await vi.waitFor(async () => {
      const listed = await admin.api.screenTrust.waiting();
      const found = listed.find(
        ({ app: id, version }) => id === app && version === 2
      );
      if (found === undefined) {
        throw new Error("Not recorded yet");
      }
      return found;
    }, pushWait);

    expect({
      waitingNow: waitingNow.screens,
      recorded,
      afterApproval,
      approved,
      nextVersion: nextVersion.version,
    }).toStrictEqual({
      waitingNow: ["notes"],
      recorded: "screen.unreviewed",
      afterApproval: false,
      approved: "ok",
      nextVersion: 2,
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

  it("reviews a version whose screen doesn't build, and still lists earlier approvals to take back", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    await approveCurrent(admin, app);
    const first = await openFrame(builder, app);
    // Version 2 adds a screen that doesn't build.
    await release(builder, app, {
      "screens/broken.tsx":
        'import leftPad from "left-pad";\nexport default () => leftPad;\n',
    });

    const review = await admin.api.screenTrust.review(app);
    await admin.api.screenTrust.revoke(app, first.artifact);
    const after = await admin.api.screenTrust.review(app);

    expect({
      version: review.version,
      screens: review.screens.map(({ screen, artifact, trust }) => ({
        screen,
        builds: artifact !== null,
        trust,
      })),
      decided: review.decided.map(({ artifact, trust }) => ({
        first: artifact === first.artifact,
        trust,
      })),
      after: after.decided.map(({ trust }) => trust),
    }).toStrictEqual({
      version: 2,
      screens: [
        { screen: "broken", builds: false, trust: "unreviewed" },
        // Screens build together: one that doesn't fails them all.
        { screen: "notes", builds: false, trust: "unreviewed" },
      ],
      decided: [{ first: true, trust: "approved" }],
      after: ["revoked"],
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
