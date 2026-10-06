import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Role } from "@grasp-os/shared/roles";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import { screenLimits } from "@grasp-os/shared/screens";
import type { ScreenBundle } from "@grasp-os/shared/screens";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  approveScreens,
  classifyOutput,
  revokeScreen,
} from "../src/screen-trust-rpc.ts";
import { mockIdp } from "./idp.ts";
import { appModulesOf, kitModulesOf, loadFrame } from "./screen-frames.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// Whether an App's data reaches a screen, taken from the side of the code
// that wants it: a screen nobody approved, which says it is approved,
// names another build's hash, borrows someone else's lease, or keeps
// asking after its approval was taken back. And from the side of whoever
// would approve without the right to, or approve something other than
// what they were shown. The sample App runs for real, and what it holds
// stands for a client's data.

const idp = mockIdp();

const secret = "Acme owes 4,200";

const serverCode = `import { DurableObject } from "cloudflare:workers";

type Caller = { userId: string };
type Watcher = ((notes: string[]) => Promise<void>) & Disposable & { dup(): Watcher };

export class App extends DurableObject {
  #watchers = new Set<Watcher>();
  #refusedPushes = 0;

  notes(): string[] {
    return [${JSON.stringify(secret)}];
  }

  watchNotes(_caller: Caller, onChange: Watcher): void {
    this.#watchers.add(onChange.dup());
  }

  // Reads, tells the screen it has, pushes to whoever watches, answers.
  async slowNotes(_caller: Caller, afterRead: (step: string) => Promise<void>): Promise<string[]> {
    const notes = this.notes();
    await afterRead("read");
    for (const watcher of this.#watchers) {
      try {
        await watcher(notes);
      } catch {
        this.#refusedPushes += 1;
      }
    }
    return notes;
  }

  refusedPushes(): number {
    return this.#refusedPushes;
  }

  // Reads, tells the screen it has, then fails with what it read.
  async failingNotes(_caller: Caller, afterRead: () => Promise<void>): Promise<never> {
    const [note] = this.notes();
    await afterRead();
    throw new Error(note);
  }
}
`;

const screenOf = (
  label: string
): string => `import { callServer } from "@grasp-os/sdk/screen";
import { Button } from "@grasp-os/ui/components/button";

export default function Notes() {
  return <Button onClick={() => void callServer("notes")}>${label}</Button>;
}
`;

const sampleFiles = {
  "app/server.ts": serverCode,
  "screens/notes.tsx": screenOf("Notes"),
};

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

const nothing = async (): Promise<void> => {
  // Nothing happens between the App's read and its failure.
};

/** What a call failed with, and whether anything in it carries the App's data. */
const failureOf = async (
  call: Promise<unknown>
): Promise<{ code: unknown; carriesData: boolean }> => {
  try {
    await call;
    return { code: "ok", carriesData: false };
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
        outcome(builder.api.screens.call(app, "notes", [])),
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
      after: await builder.api.screens.call(app, "notes", []),
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
      after: [secret],
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
        // oxlint-disable-next-line no-await-in-loop -- see above
        await outcome(api.screens.call(unapproved, "notes", [])),
      ];
    }
    // Someone else's lease on the approved App names the approved build,
    // but core signed it for the builder: for anyone else it says nothing,
    // while their own does.
    const borrowed = [
      await other.api.screens.present(approved, real.lease),
      await outcome(other.api.screens.call(approved, "notes", [])),
    ];
    const own = await openFrame(other, approved);
    const withOwn = await other.api.screens.call(approved, "notes", []);
    // A connection that presented its lease loses it to a forgery: it
    // can't keep the approved build while its frame runs something else.
    const afterForgery = [
      await other.api.screens.present(approved, `${own.artifact}.forged`),
      await outcome(other.api.screens.call(approved, "notes", [])),
    ];

    expect({ presented, borrowed, withOwn, afterForgery }).toStrictEqual({
      presented: Object.fromEntries(
        Object.keys(forgeries).map((name) => [
          name,
          ["unreviewed", "screen.unreviewed"],
        ])
      ),
      borrowed: ["unreviewed", "screen.unreviewed"],
      withOwn: [secret],
      afterForgery: ["unreviewed", "screen.unreviewed"],
    });
  });

  it("asks for a new approval when the screen's code changes, and for none when it doesn't", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    await approveCurrent(admin, app);
    const first = await openFrame(builder, app);

    // Server code alone: the screen builds to the same bytes.
    await release(builder, app, {
      "app/server.ts": `${serverCode}\n// Changed.\n`,
    });
    const sameScreen = await builder.api.screens.open(app, "notes");
    // The screen itself: other bytes, which nobody approved.
    await release(builder, app, { "screens/notes.tsx": screenOf("Send") });
    const changed = await outcome(builder.api.screens.open(app, "notes"));
    const review = await admin.api.screenTrust.review(app);
    // The frame opened before still runs what was approved.
    const oldFrame = await builder.api.screens.call(app, "notes", []);
    // Back to the first screen: its approval is of those bytes, whichever
    // version holds them.
    await release(builder, app, { "screens/notes.tsx": screenOf("Notes") });
    const back = await builder.api.screens.open(app, "notes");

    // The same files in another App build to the same bytes, from the
    // same cached build: that App's screen is still nobody's to trust.
    const copy = await sampleApp(builder);
    const inCopy = await outcome(builder.api.screens.open(copy, "notes"));

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
    }).toStrictEqual({
      sameScreen: true,
      changed: "screen.unreviewed",
      review: [{ screen: "notes", trust: "unreviewed", other: true }],
      oldFrame: [secret],
      back: true,
      inCopy: "screen.unreviewed",
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
    const pushed: unknown[] = [];
    await builder.api.screens.call(app, "watchNotes", [
      (notes: unknown) => {
        pushed.push(notes);
      },
    ]);

    let answered: string[] = [];
    let cachedBuild = "";
    const events = await auditedDuring(async () => {
      answered = [
        // The App has read the data and says so; the approval is taken
        // back before it pushes and answers.
        await outcome(
          builder.api.screens.call(app, "slowNotes", [
            async () => {
              await admin.api.screenTrust.revoke(app, bundle.artifact);
            },
          ])
        ),
        await outcome(builder.api.screens.call(app, "notes", [])),
        await outcome(builder.api.screens.watchRuns(app, "invoices", noop)),
      ];
      // The build is still in the cache; it opens nothing.
      cachedBuild = await outcome(builder.api.screens.open(app, "notes"));
    });
    const standing = await builder.api.screens.present(app, bundle.lease);
    // A screen revoked no longer waits on an admin: it was decided.
    const waiting = await waitsOn(admin, app);
    // Approved again by a person, it runs again, and says what it saw.
    await approveCurrent(admin, app);
    const refusedPushes = await builder.api.screens.call(
      app,
      "refusedPushes",
      []
    );

    expect({
      answered,
      cachedBuild,
      pushed,
      refusedPushes,
      standing,
      waiting,
      events: events.map(({ action, detail }) =>
        action === "app.artifact.refused"
          ? `refused ${detail.operation}/${detail.stage}: ${detail.reason}`
          : action
      ),
    }).toStrictEqual({
      answered: ["screen.revoked", "screen.revoked", "screen.revoked"],
      cachedBuild: "screen.revoked",
      pushed: [],
      refusedPushes: 1,
      standing: "revoked",
      waiting: false,
      events: [
        "app.artifact.revoked",
        "refused call/push: revoked",
        "refused call/delivery: revoked",
        "refused call/admission: revoked",
        "refused watchRuns/admission: revoked",
        "refused open/admission: revoked",
      ],
    });
  });

  it("holds every way from an App to an unapproved screen, and leaves the screen its own reports", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const { screens } = builder.api;

    const events = await auditedDuring(async () => {
      expect({
        gated: await Promise.all([
          outcome(screens.call(app, "notes", [])),
          outcome(screens.startRun(app, "invoices")),
          outcome(screens.runs(app, "invoices")),
          outcome(screens.run(app, "run-1")),
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
        gated: Array.from({ length: 6 }, () => "screen.unreviewed"),
        version: 1,
        report: "ok",
      });
    });

    expect(refusals(events).toSorted()).toStrictEqual([
      "call/admission: unreviewed",
      "decide/admission: unreviewed",
      "run/admission: unreviewed",
      "runs/admission: unreviewed",
      "startRun/admission: unreviewed",
      "watchRuns/admission: unreviewed",
    ]);
  });

  it("opens an App whose data an admin classified as ordinary to code nobody approved, until they take that back", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const app = await sampleApp(builder);

    let ordinary: unknown[] = [];
    const events = await auditedDuring(async () => {
      await classifyAs(admin, app, "ordinary");
      // Said again: nothing changes, and nothing is recorded.
      await classifyAs(admin, app, "ordinary");
      const bundle = await openFrame(builder, app);
      ordinary = [
        await builder.api.screens.call(app, "notes", []),
        await builder.api.screens.present(app, bundle.lease),
        // Nothing waits on an admin for it.
        await waitsOn(admin, app),
      ];
      await classifyAs(admin, app, "sensitive");
    });

    expect({
      ordinary,
      sensitiveAgain: await outcome(builder.api.screens.call(app, "notes", [])),
      classified: events
        .filter(({ action }) => action === "app.output.classified")
        .map(({ actor, target, detail }) => ({ actor, target, detail })),
    }).toStrictEqual({
      ordinary: [[secret], "open", false],
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
      builder.api.screens.call(app, "failingNotes", [nothing])
    );
    let revoked: Awaited<ReturnType<typeof failureOf>> | undefined;
    const events = await auditedDuring(async () => {
      // The App reads, the approval is taken back, then the App fails.
      revoked = await failureOf(
        builder.api.screens.call(app, "failingNotes", [
          async () => {
            await admin.api.screenTrust.revoke(app, bundle.artifact);
          },
        ])
      );
    });

    expect({ approved, revoked, refused: refusals(events) }).toStrictEqual({
      approved: { code: "app.failed", carriesData: true },
      revoked: { code: "screen.revoked", carriesData: false },
      refused: ["call/delivery: revoked"],
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
      call: await outcome(builder.api.screens.call(app, "notes", [])),
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
    const opened = await outcome(builder.api.screens.call(app, "notes", []));
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
      refused: await outcome(builder.api.screens.call(app, "notes", [])),
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
      oldFrame: await outcome(builder.api.screens.call(app, "notes", [])),
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
      object: { type: "workflow", appId: granted, workflowId: "invoices" },
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
    const app = await sampleApp(builder);
    // Recorded in the background as it was made current: soon after.
    const waitingNow = await vi.waitFor(async () => {
      const listed = await admin.api.screenTrust.waiting();
      const found = listed.find(({ app: id }) => id === app);
      if (found === undefined) {
        throw new Error("Not recorded yet");
      }
      return found;
    });
    await approveCurrent(admin, app);
    const afterApproval = await waitsOn(admin, app);
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
    });

    expect({
      waitingNow: waitingNow.screens,
      afterApproval,
      nextVersion: nextVersion.version,
    }).toStrictEqual({
      waitingNow: ["notes"],
      afterApproval: false,
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
      failed = await outcome(builder.api.screens.call(app, "notes", []));
    } finally {
      await env.DB.prepare("DROP TRIGGER refuse_refusals").run();
    }
    const events = await auditedDuring(async () => {
      await outcome(builder.api.screens.call(app, "notes", []));
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
});
