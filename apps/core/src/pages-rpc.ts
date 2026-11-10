// oxlint-disable max-classes-per-file -- a connection's pages, and each frame's own way to its App on that connection, which shares its checks
import { appErrors, appVersionSchema } from "@grasp-os/shared/apps";
import type { App } from "@grasp-os/shared/apps";
import type {
  DecisionConfirmation,
  DecisionReview,
  DecisionView,
} from "@grasp-os/shared/decisions";
import { authErrors, isExpectedError } from "@grasp-os/shared/errors";
import { functionRequestMaxBytes } from "@grasp-os/shared/function-limits";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  jsonBytes,
  rateLimited,
  pageErrors,
  pageLimits,
  pageHrefSchema,
  pageProblemSchema,
} from "@grasp-os/shared/pages";
import type {
  PageDelivery,
  AppErrorLog,
  AppVersionPush,
  QuerySnapshotPush,
  PageBundle,
  PageFrameApi,
  PagesApi,
  SidebarApp,
  SurfaceSummary,
} from "@grasp-os/shared/pages";
import type { Identity } from "@grasp-os/shared/rpc";
import { TokenBuckets } from "@grasp-os/shared/token-bucket";
import { z } from "zod";

import { sealedSurfaces } from "./app-releases.ts";
import {
  appFor,
  findVersion,
  getApp,
  hasPages,
  listApps,
  usableApp,
  versionFiles,
} from "./apps.ts";
import { appHost } from "./durable-objects.ts";
import { isStub } from "./page-callbacks.ts";
import type { PageCallback } from "./page-callbacks.ts";
import {
  deliveryOf,
  deliveryAt,
  delivering,
  readLease,
  leaseFor,
  requireDelivery,
  standingOf,
} from "./page-delivery.ts";
import type { LeasedBuild, PageLease } from "./page-delivery.ts";
import { frameAccess, stageFrame } from "./page-frame.ts";
import { versionPageCodes } from "./page-references.ts";
import { QuerySubscriptions, pageReads } from "./query-subscriptions.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { Subscription } from "./subscription.ts";
import {
  confirmPageDecision,
  decidePageRun,
  reviewPageDecision,
} from "./workflows/page-decisions.ts";

// What the frontend's page host reaches for the frames it runs (see
// @grasp-os/runtime/page): an App's page to load, its server to
// call and its current version. Next to them, never on the frame bridge
// and for the App's builders only, its error log (`errors`): its pages'
// problems and what its server code wrote with `console`
// (server-logs.ts). Pages run code nobody
// reviewed line by line, which the page passes on as it is, so everything
// here takes the frame's input as untrusted and checks the person's
// session and role on every call.
//
// What a page may ask is bounded here and in the App's host, never only
// on the page, which a person can change: each person's requests of an
// App and its pages' reports by rate (`admitted`, `reportProblem`), an
// answer by its size in bytes (`withinAnswer`). Who is asking is always the session core checked; a
// page names only its App, and has a role in it or is refused.
//
// Anyone with a role in the App (app-access.ts) uses its pages: opens
// them, calls its functions, reports problems, and starts, follows and
// answers its workflow runs (workflows/page-decisions.ts). Only its builders
// read its error log.
//
// A page's build needs nobody's approval: it reaches only its App's
// functions, as its viewer (page-delivery.ts says why that is enough).
// What still keeps the App's data from a page is its release revoked,
// or a frame core leased no build: every call here that reaches the App's
// data or its runs passes that gate, and so does every push; only a page's own reports of its
// problems, the App's version number and its error log, which only its
// builders read and no frame reaches, don't. Which build a frame runs is the one
// core leased it (`frame`), never what the frame says.
//
// A callback the App keeps (a page's subscription) outlives the call
// that passed it, so each push through it checks again that the person
// still has a role in the App (the live queries' gate, query-subscriptions.ts,
// and `followVersion`), once per reading of the
// connection's session (at most every `sessionRecheckMs`) per App and
// connection. Once they don't (signed out, unshared, a team left, a role
// changed, a source they can't read), the callback is released and
// forwards nothing more: losing access stops a page within a few
// seconds, whatever the App does.

/**
 * Most Apps one connection follows the current version of at once
 * (`watchVersion`): the page follows each App its tab's frames run once,
 * however many frames of it are open, so this only bounds a page that
 * follows over and over.
 */
const maxVersionSubscriptions = 20;

/**
 * The App `app` names, for the person, once the App's host has counted
 * this request of theirs: `page.rate_limited` past what one person's
 * pages of an App may ask (`pageLimits.requests`).
 */
const admittedApp = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<App> => {
  const found = await usableApp(env, by, app);
  if (!(await appHost(env, found.id).admitRequest(by.userId))) {
    throw rateLimited();
  }
  return found;
};

/** `admittedApp`, for its ID. */
export const admitted = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<AppId> => {
  const { id } = await admittedApp(env, by, app);
  return id;
};

/**
 * Counts a call of a draft's preview as a request of the person's
 * (`admitted`), for an App whose role core has checked already.
 */
export const admitPreviewCall = async (
  env: Env,
  by: Pick<Identity, "userId">,
  app: AppId
): Promise<void> => {
  if (!(await appHost(env, app).admitRequest(by.userId))) {
    throw rateLimited();
  }
};

/** `answer`, if it is no more than a page takes in one call. */
export const withinAnswer = <Answer>(answer: Answer): Answer => {
  if (jsonBytes(answer, pageLimits.answerBytes) > pageLimits.answerBytes) {
    throw pageErrors.create("page.answer_too_large");
  }
  return answer;
};

/**
 * A running App's pages, built from its current version, with core's
 * lease on that build for the person: only a build that gets the App's
 * data now (its release not revoked), once this request of theirs is
 * counted (`admitted`). One that doesn't is refused before its code is
 * where a frame can load it; one that does is put there (`stageFrame`).
 * Which route the frame shows is its router's, from the page's address:
 * the routes are the App's code, which reads what it is given as anyone's
 * link (spec 10.7.7), so core never reads the address.
 */
const openPage = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<PageBundle> => {
  const {
    id,
    name: appName,
    currentVersion: version,
  } = await admittedApp(env, by, app);
  if (version === null) {
    throw appErrors.create("app.not_running");
  }
  const raw = await versionFiles(env, id, version);
  const built = await versionPageCodes(env, id, version, raw, {
    unsealed: "refuse",
  });
  const { artifact } = built;
  const build = { artifact, version };
  await requireDelivery(env, by, id, build, {
    operation: "open",
    stage: "admission",
  });
  await stageFrame(env, artifact, built.code);
  return {
    app: id,
    name: appName,
    version,
    artifact,
    frameToken: await frameAccess(env, artifact),
    lease: await leaseFor(env, by.userId, id, { kind: "release", build }),
  };
};

/**
 * The pages of a published App's current version, for a visitor
 * (app-visitors.ts), which open at `/`: built and staged as `openPage`
 * does, once their build gets the App's data now, and leased to `visitor`
 * (`visitor:<session>`), a name no member's session has, so it opens the
 * App's functions only as that visitor, with their session's token
 * (page-calls.ts). Null while the App runs no version or has no pages.
 */
export const visitorPage = async (
  env: Env,
  found: Pick<App, "id" | "name" | "currentVersion">,
  visitor: string
): Promise<PageBundle | null> => {
  const { id, name: appName, currentVersion: version } = found;
  if (version === null) {
    return null;
  }
  const raw = await versionFiles(env, id, version);
  if (!hasPages(new Map(Object.entries(raw)))) {
    return null;
  }
  const built = await versionPageCodes(env, id, version, raw, {
    unsealed: "refuse",
  });
  const { artifact } = built;
  const build = { artifact, version };
  if (deliveryOf(await standingOf(env, id, build)) !== "open") {
    throw pageErrors.create("page.revoked");
  }
  await stageFrame(env, artifact, built.code);
  return {
    app: id,
    name: appName,
    version,
    artifact,
    frameToken: await frameAccess(env, artifact),
    lease: await leaseFor(env, visitor, id, { kind: "release", build }),
  };
};

/**
 * The surfaces of `app`'s current version (spec 34.1), for someone with a
 * role in it: none while it has no version. Listing them opens nothing:
 * each is opened, and checked, as the App's pages are.
 */
const appSurfaces = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<SurfaceSummary[]> => {
  // Counted as one of the person's requests of the App, as opening is.
  const { id, currentVersion: version } = await admittedApp(env, by, app);
  return version === null ? [] : await sealedSurfaces(env, id, version);
};

/** The most Apps the sidebar reads the surfaces of, and how many at once. */
const sidebarLimits = { apps: 50, together: 5 };

/**
 * How often a person may read the sidebar: one read reads up to
 * `sidebarLimits.apps` Apps, so each person's reads are counted, in this
 * isolate, apart from their requests of any one App.
 */
const sidebarReads = new TokenBuckets({ burst: 10, perMinute: 30 });

/**
 * One App's sidebar entries; none when its surfaces can't be read now,
 * so one App failing leaves the others' entries as they are.
 */
const sidebarEntries = async (
  env: Env,
  app: App & { currentVersion: number }
): Promise<SidebarApp> => {
  let surfaces: SurfaceSummary[] = [];
  try {
    // Only what its release sealed: listing never builds or runs App code.
    const declared = await sealedSurfaces(env, app.id, app.currentVersion);
    const listed = declared.filter(({ kind }) => kind === "sidebar");
    // A revoked release's pages get nothing: none of them is offered.
    // Opening one still checks it, whatever this says.
    const { releaseRevoked } = await standingOf(env, app.id);
    surfaces = releaseRevoked ? [] : listed;
  } catch (error) {
    if (!isExpectedError(error)) {
      log.warn("page.sidebar_app_failed", {
        appId: app.id,
        ...errorFields(error),
      });
    }
  }
  return { app: app.id, name: app.name, entries: surfaces };
};

/**
 * The sidebar entries of the Apps the person has a role in (spec 34.1):
 * each App with sidebar surfaces, with those, in the order the Apps list.
 * At most `sidebarLimits.apps` Apps, read a few at a time; each read is
 * of what their releases sealed, so the listing never builds or runs App
 * code.
 */
const sidebarSurfaces = async (
  env: Env,
  by: Identity
): Promise<SidebarApp[]> => {
  if (!sidebarReads.take(by.userId)) {
    throw rateLimited();
  }
  const apps = await listApps(env, by);
  const found = apps
    .flatMap((app) =>
      app.currentVersion === null
        ? []
        : [{ ...app, currentVersion: app.currentVersion }]
    )
    .slice(0, sidebarLimits.apps);
  const listed: SidebarApp[] = [];
  for (let at = 0; at < found.length; at += sidebarLimits.together) {
    const batch = found.slice(at, at + sidebarLimits.together);
    // oxlint-disable-next-line no-await-in-loop -- a few Apps at a time, on purpose
    const read = await Promise.all(
      batch.map(async (app) => await sidebarEntries(env, app))
    );
    listed.push(...read);
  }
  return listed.filter(({ entries }) => entries.length > 0);
};

/**
 * Follows `app`'s current version for `by`'s page (`PagesApi.watchVersion`,
 * spec 11.5), through the connection's way to the App's host
 * (`QuerySubscriptions.follow`), which tells it when another version was
 * made current and when the person's access may have dropped. Threat
 * model, and how each is closed:
 *
 * - Someone without a role in the App learns its version: every push is
 *   read as the person behind the connection then (its session read again
 *   and the App's rules, `getApp`), never from the event; once they lost
 *   the App (or their session, or it is someone else's) the refusal is
 *   the last push and the page's callback is let go of.
 * - An event that is forged, late or twice: it only makes core read the
 *   version again; only core reaches an App's host.
 * - A missed event: the version is pushed at once, and again on every
 *   look the host's restart or a revocation causes; a page that connects
 *   again follows anew, and gets it at once.
 * - Pushes out of order: one at a time, each read when its turn comes,
 *   so the last the page gets is the newest.
 * - A page that follows without end: at most `maxVersionSubscriptions`
 *   per connection, each let go of when it is released, its callback is
 *   gone, or the connection closes.
 */
const followVersion = (
  env: Env,
  check: SessionCheck,
  by: Identity,
  app: AppId,
  stub: PageCallback,
  queries: QuerySubscriptions,
  subscriptions: Set<Disposable>
): Subscription => {
  const toPage = stub.dup();
  const state: { live: boolean; following?: Disposable; turn: Promise<void> } =
    { live: true, turn: Promise.resolve() };
  const held: Disposable = {
    [Symbol.dispose]: () => {
      if (!state.live) {
        return;
      }
      state.live = false;
      subscriptions.delete(held);
      state.following?.[Symbol.dispose]();
      toPage[Symbol.dispose]();
    },
  };
  const release = (): void => {
    held[Symbol.dispose]();
  };
  /** What to push now: the version as the person may read it, if read. */
  const read = async (
    recheck: boolean
  ): Promise<AppVersionPush | undefined> => {
    try {
      const person = await check();
      if (person.userId !== by.userId) {
        throw authErrors.create("auth.principal_changed");
      }
      const { currentVersion } = await usableApp(env, person, app);
      return { type: "current", version: currentVersion, recheck };
    } catch (error) {
      if (!isExpectedError(error)) {
        // Read again at the next event: the database away for a moment
        // is no lost role.
        log.warn("page.version_read_failed", {
          appId: app,
          ...errorFields(error),
        });
        return undefined;
      }
      return {
        type: "refused",
        error: { code: error.code, message: error.message },
      };
    }
  };
  const pushNow = async (recheck: boolean): Promise<void> => {
    const sent = state.live ? await read(recheck) : undefined;
    if (sent === undefined || !state.live) {
      return;
    }
    try {
      await toPage(sent);
    } catch {
      // The page didn't take it: gone, or its callback failed.
      release();
      return;
    }
    if (sent.type === "refused") {
      release();
    }
  };
  const push = async (recheck: boolean): Promise<void> => {
    const before = state.turn;
    const mine = (async (): Promise<void> => {
      await before;
      await pushNow(recheck);
    })();
    state.turn = mine;
    await mine;
  };
  subscriptions.add(held);
  state.following = queries.follow(
    by,
    app,
    async () => {
      await push(true);
    },
    release,
    async () => {
      await push(false);
    }
  );
  void push(false);
  return new Subscription(async () => {
    release();
    await Promise.resolve();
  });
};

/**
 * Whether `by` has a role in `app` now, for a live query's gate before
 * each push (query-subscriptions.ts): false when refused, while a failure
 * nobody expected (the database away for a moment) is thrown, so the gate
 * refuses as one to try again, never as a lost role, which would sign
 * the page out of the App. `by` is the gate's own reading of the
 * session, and the gate keeps the answer for a second.
 */
const hasRoleNow = async (
  env: Env,
  by: Identity,
  app: AppId,
  role: "user" | "builder"
): Promise<boolean> => {
  try {
    await usableApp(env, by, app, role);
    return true;
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    throw error;
  }
};

/** Where in the App a problem happened, as the page reports it. */
const reportedAtSchema = z.strictObject({
  version: appVersionSchema,
  path: pageHrefSchema,
});

const reportProblem = async (
  env: Env,
  by: Identity,
  app: unknown,
  at: unknown,
  problem: unknown
): Promise<void> => {
  const { id } = await getApp(env, by, app);
  // Counted before it is read: a report that says nothing valid, or more
  // than is kept, costs the App's log one number at most.
  if (!(await appHost(env, id).admitReport(by.userId))) {
    throw rateLimited();
  }
  const where = pageErrors.parse("page.invalid", reportedAtSchema, at);
  const reported = pageErrors.parse("page.invalid", pageProblemSchema, problem);
  // One of the App's versions, or `app.version_not_found`.
  await findVersion(env, id, where.version);
  await appHost(env, id).logError({
    at: new Date().toISOString(),
    source: "page",
    ...where,
    ...reported,
  });
};

const errorLog = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<AppErrorLog> => {
  const { id } = await appFor(env, by, app, "builder");
  return await appHost(env, id).errors();
};

/** What a frame's capability shares with its connection (`PagesRpc`). */
interface FrameConnection {
  readonly env: Env;
  readonly check: SessionCheck;
  /** Who the frame was opened for. */
  readonly userId: string;
  readonly app: AppId;
  /** What core leased the frame, if the lease was core's for them. */
  readonly lease: PageLease | undefined;
  /** The connection's live queries, bounded for the whole tab. */
  readonly queries: QuerySubscriptions;
}

/**
 * One frame's way to its App on the connection a tab's frames share
 * (`PagesApi.frame`): a running App's page, or a builder's preview of
 * their draft, as the frame's lease names it (page-calls.ts says how one
 * path for both is kept apart). Threat model, and how each is closed:
 *
 * - Frame A decided on frame B's build: every call is decided on the
 *   lease this frame was opened with, never on what another frame of
 *   the App runs, so a frame
 *   whose build was revoked is refused while another frame's goes on.
 * - A preview reaching the App's real data: a draft's frame reads only
 *   its draft on the throwaway store (draft-runs.ts), and starts, follows
 *   and answers no workflow run (`app.preview_side_effect`).
 * - A closed frame following on: what it follows through here (its live
 *   queries, its runs' updates, the callbacks its server calls passed)
 *   is kept in `#held`, and `close`, or the page letting go of the stub,
 *   lets go of all of it at once; a closed frame is refused every call,
 *   and its callbacks push nothing more.
 * - Another person: a call checks the connection's session as every call
 *   does, and is refused unless it is still the person the frame was
 *   opened for (`auth.principal_changed`).
 *
 * The tab's bounds (how many queries and run subscriptions, what waits
 * to be pushed) stay the connection's, as spec 11.4 sets them per tab.
 */
export class PageFrameRpc extends CoreRpcTarget implements PageFrameApi {
  readonly #connection: FrameConnection;
  /** What the frame follows, let go of when it closes. */
  readonly #held = new Set<Disposable>();
  #closed = false;

  constructor(connection: FrameConnection) {
    super();
    this.#connection = connection;
  }

  /**
   * Keeps `held` until the frame closes; a frame that closed while it was
   * being made (its call admitted, its subscription opened) lets go of it
   * at once.
   */
  #keep(held: Disposable): void {
    this.#held.add(held);
    if (this.#closed) {
      held[Symbol.dispose]();
    }
  }

  /** Refuses once the frame closed (`page.invalid`). */
  #open(): void {
    if (this.#closed) {
      throw pageErrors.create("page.invalid");
    }
  }

  /** The person behind the connection, still the frame's, if it is open. */
  async #person(): Promise<Identity> {
    this.#open();
    const by = await this.#connection.check();
    // Closed while the session was checked: nothing goes on.
    this.#open();
    if (by.userId !== this.#connection.userId) {
      throw authErrors.create("auth.principal_changed");
    }
    return by;
  }

  /** The build of the App's release the frame runs, if its lease names one. */
  get #build(): LeasedBuild | undefined {
    const { lease } = this.#connection;
    return lease?.kind === "release" ? lease.build : undefined;
  }

  /**
   * `run`, a step of one of the App's workflow runs, once this request of
   * the person's is counted (`admitted`), if the frame's build gets the
   * App's data now (`delivering`): never a draft's, whose preview starts,
   * follows and answers no real run.
   */
  async #delivered<Answer>(
    operation: string,
    run: (by: Identity) => Promise<Answer>
  ): Promise<Answer> {
    const by = await this.#person();
    const { env, app, lease } = this.#connection;
    const id = await admitted(env, by, app);
    if (lease?.kind === "draft") {
      throw appErrors.create("app.preview_side_effect");
    }
    return await delivering(env, by, id, this.#build, operation, async () => {
      // Closed while it was admitted: nothing runs.
      this.#open();
      return await run(by);
    });
  }

  /**
   * `subscription`, kept until it is released or the frame closes: the
   * page gets a hold that releases both.
   */
  async #hold(
    open: (ended: () => void) => Subscription | Promise<Subscription>
  ): Promise<Subscription> {
    // Told when the subscription ends on its own (a refusal, a store
    // that can't be watched, a callback the page no longer takes): the
    // frame forgets it then, so ended ones don't pile up while it's open.
    const state: { hold?: Subscription; ended: boolean } = {
      ended: false,
    };
    // Ended, it is still released: what holds it besides its callback (a
    // run watch in the App's host) goes now, not at the next push.
    const subscription = await open(() => {
      state.ended = true;
      void state.hold?.release();
    });
    const hold = new Subscription(async () => {
      this.#held.delete(hold);
      await subscription.release();
    });
    state.hold = hold;
    if (state.ended) {
      await hold.release();
    } else {
      this.#keep(hold);
    }
    return hold;
  }

  async delivery(): Promise<PageDelivery> {
    const by = await this.#person();
    const { env, app, lease } = this.#connection;
    // The person's role in the App first, as every call's: someone who
    // lost it hears that, never how the App's build stands. Nobody's frame
    // of an archived App is delivered anything. A draft's reaches none of
    // the App's data, so only its builder counts.
    const { id } = await usableApp(
      env,
      by,
      app,
      lease?.kind === "draft" ? "builder" : "user"
    );
    return lease?.kind === "draft"
      ? "open"
      : deliveryOf(await standingOf(env, id, this.#build));
  }

  async reviewDecision(
    run: string,
    decision: string,
    answer: unknown
  ): Promise<DecisionReview> {
    const { env, app } = this.#connection;
    return await this.#delivered(
      "reviewDecision",
      async (by) =>
        await reviewPageDecision(
          env,
          by,
          { app, version: this.#build?.version },
          run,
          decision,
          answer
        )
    );
  }

  async confirmDecision(
    run: string,
    decision: string,
    revision: string,
    answer: unknown
  ): Promise<DecisionConfirmation> {
    const { env, app } = this.#connection;
    return await this.#delivered(
      "confirmDecision",
      async (by) =>
        await confirmPageDecision(
          env,
          by,
          { app, version: this.#build?.version },
          run,
          decision,
          revision,
          answer
        )
    );
  }

  async decide(
    run: string,
    decision: string,
    answer: unknown,
    confirmation?: string
  ): Promise<DecisionView> {
    const { env, app } = this.#connection;
    return await this.#delivered(
      "decide",
      async (by) =>
        await decidePageRun(
          env,
          by,
          { app, version: this.#build?.version },
          run,
          decision,
          answer,
          confirmation
        )
    );
  }

  async watchQuery(
    request: string,
    onSnapshot: (snapshot: QuerySnapshotPush) => void
  ): Promise<Subscription> {
    const by = await this.#person();
    const { env, app, lease, queries } = this.#connection;
    // Following is a request like any other; what core then pushes is
    // not counted (query-subscriptions.ts bounds it).
    const id = await admitted(env, by, app);
    if (
      typeof request !== "string" ||
      request.length > functionRequestMaxBytes ||
      !isStub(onSnapshot)
    ) {
      throw pageErrors.create("page.invalid");
    }
    // A draft's builder is checked as it is read (draft-runs.ts).
    if (lease?.kind !== "draft") {
      await requireDelivery(env, by, id, this.#build, {
        operation: "watchQuery",
        stage: "admission",
      });
    }
    return await this.#hold((ended) =>
      queries.subscribe(by, id, lease, request, onSnapshot, ended)
    );
  }

  /** Lets go of everything the frame follows; refuses its calls from now on. */
  async close(): Promise<void> {
    this.#closed = true;
    // Each takes itself off the set as it goes, which a set allows.
    for (const held of this.#held) {
      held[Symbol.dispose]();
    }
    this.#held.clear();
    await Promise.resolve();
  }

  [Symbol.dispose](): void {
    void this.close();
  }
}

/**
 * A signed-in person's `pages`. Like the other APIs of a session, every
 * call checks the session first and hands the identity that check returned
 * on; each function checks the person's role.
 */
export class PagesRpc extends CoreRpcTarget implements PagesApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  /** This connection's version subscriptions that haven't been released. */
  readonly #versionSubscriptions = new Set<Disposable>();

  /** This connection's live queries (query-subscriptions.ts). */
  readonly #queries: QuerySubscriptions;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
    this.#queries = new QuerySubscriptions(
      env,
      pageReads(env, check, async (by, app, lease) => {
        // A draft's preview is its builder's alone, and reaches none of
        // the App's data, so nothing else is read for it.
        if (lease?.kind === "draft") {
          return (await hasRoleNow(env, by, app, "builder")) ? "open" : "role";
        }
        if (!(await hasRoleNow(env, by, app, "user"))) {
          return "role";
        }
        return await deliveryAt(env, by, app, lease?.build, {
          operation: "watchQuery",
          stage: "push",
        });
      })
    );
  }

  async open(app: string): Promise<PageBundle> {
    return await withPerson(
      this.#check,
      async (by) => await openPage(this.#env, by, app)
    );
  }

  async surfaces(app: string): Promise<SurfaceSummary[]> {
    return await withPerson(
      this.#check,
      async (by) => await appSurfaces(this.#env, by, app)
    );
  }

  async sidebar(): Promise<SidebarApp[]> {
    return await withPerson(
      this.#check,
      async (by) => await sidebarSurfaces(this.#env, by)
    );
  }

  async frame(app: string, lease: string): Promise<PageFrameRpc> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await usableApp(this.#env, by, app);
      // Core's own lease names the build and what it runs on, never the
      // page or the frame; a lease core didn't sign for them and this App
      // names none, and is decided as code core didn't serve.
      return new PageFrameRpc({
        env: this.#env,
        check: this.#check,
        userId: by.userId,
        app: id,
        lease: await readLease(this.#env, by.userId, id, lease),
        queries: this.#queries,
      });
    });
  }

  async watchVersion(
    app: string,
    onVersion: (push: AppVersionPush) => void
  ): Promise<Subscription> {
    return await withPerson(this.#check, async (by) => {
      // Following is a request like any other: a page that follows and
      // lets go over and over is held to what a person may ask.
      const id = await admitted(this.#env, by, app);
      if (!isStub(onVersion)) {
        throw pageErrors.create("page.invalid");
      }
      if (this.#versionSubscriptions.size >= maxVersionSubscriptions) {
        throw pageErrors.create("page.too_many_subscriptions");
      }
      return followVersion(
        this.#env,
        this.#check,
        by,
        id,
        onVersion,
        this.#queries,
        this.#versionSubscriptions
      );
    });
  }

  async report(
    app: string,
    at: { version: number; path: string },
    problem: unknown
  ): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await reportProblem(this.#env, by, app, at, problem);
    });
  }

  async errors(app: string): Promise<AppErrorLog> {
    return await withPerson(
      this.#check,
      async (by) => await errorLog(this.#env, by, app)
    );
  }
}
