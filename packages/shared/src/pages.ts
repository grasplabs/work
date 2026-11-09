import { z } from "zod";

import type {
  DecisionAnswerInput,
  DecisionConfirmation,
  DecisionReview,
  DecisionView,
} from "./decisions.ts";
import { defineErrorFamily } from "./errors.ts";
import type { AppId } from "./ids.ts";
import {
  pageFrameMounted,
  pageFrameReady,
  pageLimits,
  pageModulePath,
} from "./page-limits.ts";

// An App's pages run in a sandboxed frame in the frontend (apps/web): a
// document core serves for one build (core's page-frame.ts), which runs
// that build's modules and nothing else, connected to its App's server
// through the page and core. Core checks the person's session and role on
// every call; the frame only ever talks to the page.

/**
 * The WebRTC interfaces that open a peer connection: the one way out of a
 * page's frame its policy doesn't close (core's security-headers.ts).
 * The compiler refuses them in a page (no-peer-connections), and the
 * frame's bootstrap takes them away before the page's code runs (core's
 * page-frame.ts).
 */
export const pagePeerInterfaces: readonly string[] = [
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "mozRTCPeerConnection",
  "RTCDataChannel",
  "RTCIceTransport",
  "RTCDtlsTransport",
  "RTCSctpTransport",
];

/**
 * Elements that hold a document of their own, and with it a realm with
 * its own WebRTC and network: refused in a page, as
 * `pagePeerInterfaces` are, by their local names.
 */
export const pageNestedDocuments: readonly string[] = [
  "iframe",
  "frame",
  "object",
  "embed",
  "fencedframe",
  "portal",
];

/** The interfaces of `pageNestedDocuments`, as a browser names them. */
export const pageNestedInterfaces: readonly string[] = [
  "HTMLIFrameElement",
  "HTMLFrameElement",
  "HTMLObjectElement",
  "HTMLEmbedElement",
  "HTMLFencedFrameElement",
  "HTMLPortalElement",
];

/** A page's code as core built it: the SHA-256, in hex, of what a frame is handed. */
export const artifactSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * Whether code gets an App's data now: `open`; `revoked` once the release
 * it runs was revoked; `unreviewed` for code Grasp didn't serve (no lease
 * core signed) while the App's data isn't `ordinary`
 * (@grasp-os/shared/data-policy). Core decides it again on every call and
 * every push.
 */
export type PageDelivery = "open" | "unreviewed" | "revoked";

export {
  appFunctionPath,
  jsonBytes,
  rpcArgumentDepth,
  pageFrameMessage,
  pageFrameMounted,
  pageFramePath,
  pageFrameReady,
  pageLanguageOf,
  pageLanguages,
  pageLeaseHeader,
  pageLimits,
  pageModulePath,
  pagePersonHeader,
  pageVisitorHeader,
  streamCallActions,
} from "./page-limits.ts";
export type { PageLanguage, StreamCallAction } from "./page-limits.ts";

/** A value the page or core made up: never longer than a hash in hex. */
const stageValue = z.string().min(1).max(128);

/**
 * The frame's `ready`, as the page reads it: `supported` is false when the
 * browser doesn't enforce what keeps a page from making a document of
 * its own (core's page-frame.ts), and the frame then starts nothing.
 */
export const pageReadySchema = z.strictObject({
  type: z.literal(pageFrameReady),
  load: stageValue,
  supported: z.boolean(),
});
export type PageReady = z.output<typeof pageReadySchema>;

/** The runtime's `mounted`, as the page reads it. */
export const pageMountedSchema = z.strictObject({
  type: z.literal(pageFrameMounted),
  load: stageValue,
  artifact: stageValue,
  generation: stageValue,
});
export type PageMounted = z.output<typeof pageMountedSchema>;

/**
 * A `.` or `..` segment of a path, escaped or not, which a browser
 * resolves against the path before it: up and out of the App's routes.
 */
const dotSegment = /\/(?:\.|%2e){1,2}(?=[/?#]|$)/iu;

/**
 * Where an App's pages are, within the App: a path of its routes, with
 * its search and hash (`/tasks/12?tab=notes`), as the frame's router and
 * the host's address carry it. Never another origin (`//host`), nor a
 * backslash or whitespace a browser might read as one, nor a dot segment
 * that would climb out of the App's part of the host's address.
 */
export const pageHrefSchema = z
  .string()
  .max(pageLimits.hrefLength)
  .regex(/^\/(?!\/)[^\s\\]*$/u, "a path of the App's own, from /")
  .refine((href) => !dotSegment.test(href.split(/[?#]/u, 1)[0] ?? ""), {
    message: "a path without . or .. segments",
  });

/** An App's sidebar entries (spec 34.1): its surfaces of kind `sidebar`. */
export interface SidebarApp {
  app: string;
  name: string;
  entries: SurfaceSummary[];
}

/** Where the host places a surface (spec 34.1). */
export const surfaceKinds = ["sidebar", "panel", "settings"] as const;
export type SurfaceKind = (typeof surfaceKinds)[number];

/**
 * One of an App's surfaces at its current version, as the host lists it
 * to place it (spec 34.1): the route of the page it opens, where it
 * goes and its title, as the page's file exports them
 * (`export const surface = { kind, title }`).
 */
export interface SurfaceSummary {
  /** The route of the page it opens: `/`, `/settings`. */
  path: string;
  kind: SurfaceKind;
  title: string;
}

/**
 * An App's pages at its current version, ready for a frame: the frame
 * loads their code from core by `artifact` (`pageFramePath`), and opens
 * the route the page asks for.
 */
export interface PageBundle {
  app: AppId;
  /** The App's name, which the page shows around the frame. */
  name: string;
  /** The App's current version, which the pages were built from. */
  version: number;
  /**
   * The SHA-256, in hex, of the code a frame runs (the pages' modules,
   * the kit's modules they load and their CSS), as core built it: what
   * core leases the frame, and what its document runs and nothing else.
   * The frame says it back once the pages have mounted
   * (`pageFrameMounted`).
   */
  artifact: string;
  /**
   * What lets the frame load that build's document from core, for a few
   * minutes (`?token=`): a sandboxed frame sends no session.
   */
  frameToken: string;
  /**
   * Core's word that it handed this person this build of this App, for
   * the page to give back when it opens the frame (`PagesApi.frame`):
   * opaque to the page, and worth nothing to anyone else.
   */
  lease: string;
}

const reportLimits = pageLimits.report;

/**
 * The query of every address on the path whose files are asked for with a
 * token in it (a page module's), up to where a stack frame's line and
 * column, a space or a bracket begins.
 */
const tokenedQuery = new RegExp(
  `(${pageModulePath}/[^\\s?#()"'\`]*)\\?[^\\s#:()"'\`]*`,
  "gu"
);

/**
 * `text` with the query of each address `tokenedQuery` finds left out.
 * Engines write a module's whole address, token and all, in every stack
 * frame and in a failed import's message; what a page reports goes to
 * the App's error log, a preview's reports, the agent's check and its
 * model, none of which may keep a token. Done where core reads a report,
 * since the frame's own code is the App's.
 */
const withoutTokens = (text: string): string =>
  text.replaceAll(tokenedQuery, "$1");

/**
 * A problem in a page, as the frame reports it: an uncaught error, an
 * unhandled rejection or a `console.error` call of the App's own code; or
 * a `warning`, a `console.error` call of the kit's (React's development
 * warnings in a preview), which shows but fails nothing. Written by App
 * code, so it is held to size and never counts as more than text; which
 * kind it is, the frame says, so it is never more than a diagnostic. No
 * address in it keeps its token (`withoutTokens`).
 */
export const pageProblemSchema = z.strictObject({
  kind: z.enum(["error", "rejection", "console", "warning"]),
  message: z
    .string()
    .transform((text) => withoutTokens(text).slice(0, reportLimits.message)),
  stack: z
    .string()
    .transform((text) => withoutTokens(text).slice(0, reportLimits.stack))
    .optional(),
});
export type PageProblem = z.output<typeof pageProblemSchema>;

/** What an App's server code wrote with `console`, one line of one call. */
export interface ServerLog {
  /** When, ISO 8601. */
  at: string;
  level: "debug" | "info" | "log" | "warn" | "error";
  /** Its arguments as text, held to size. */
  message: string;
  /** The server method whose call wrote it, when the runtime says. */
  method: string | null;
}

/**
 * What reaches an App's error log: a problem one of its pages reported,
 * or a line its server code wrote with `console` (core's server-logs.ts).
 */
export type ReportedEntry =
  | (PageProblem & {
      /** When it was reported, ISO 8601. */
      at: string;
      source: "page";
      version: number;
      /** Where in the App it happened: the route the frame showed. */
      path: string;
    })
  | (ServerLog & { source: "server"; version: number });

/**
 * One entry of an App's error log, and how often it was reported. The
 * same problem at the same route and version is one entry, and so is the
 * same line from the same method and version; `at` is the last time.
 */
export type AppErrorEntry = ReportedEntry & {
  /** How many times it was reported. */
  count: number;
};

/** An App's error log, as its builders read it. */
export interface AppErrorLog {
  /** The newest different entries, newest first. */
  entries: AppErrorEntry[];
  /**
   * At least how many reports were dropped unread because the App's
   * pages and server reported more than they may: counted, never kept one by one.
   * The last minute's count is held in memory before it is written, so a
   * flood right before the App's host restarts is counted short.
   */
  suppressed: number;
}

/**
 * The bounds of live queries (spec 11.3, 11.4): what core holds one
 * page's connection (one browser tab) and one person to, and how it
 * delivers.
 */
export const querySubscriptionLimits = {
  /**
   * Live queries one connection follows at once, the pages of one
   * paginated list counting as one.
   */
  perConnection: 100,
  /**
   * Live queries one person follows of one App at once, across tabs, and
   * subscriptions one connection holds, every page of a list counted:
   * each holds a watch in the App's store.
   */
  perPerson: 500,
  /** How long core gathers a query's changes before it reads it again. */
  coalesceMs: 50,
  /**
   * The longest it gathers them: the window stretches with how many of
   * the connection's queries wait to be read, so a write that wakes a
   * page's every query is read in fewer, later rounds, not a flood.
   */
  maxCoalesceMs: 2000,
  /** Reads of live queries one connection runs at once; the rest wait. */
  concurrentReads: 4,
  /**
   * Reads core makes of one person's live queries of one App because a
   * write changed what they read (the reads a page asks for are counted
   * as its requests instead), held by the App's host across every tab.
   * Past it a read waits, gathering every change meanwhile, and is tried
   * again later: never dropped, only slower. The burst covers one write
   * waking two full tabs (2 x `perConnection`); the rate, 10 a second,
   * is five times what a person may ask directly
   * (`pageLimits.requests`), so a write rate the person's own requests
   * allow keeps a few pages current, while one person's commits can
   * cost core at most this many sandboxed reads of their queries, however
   * many they follow. Each other person pays for their own.
   */
  liveReads: { burst: 200, perMinute: 600 },
  /** How long core waits before reading again past `liveReads`, at most. */
  liveReadWaitMs: 10_000,
  /**
   * How often core checks that the store still holds a query's watch,
   * when nothing else made it look: a watch the store lost without core
   * hearing of it is then made again, and the query read afresh.
   */
  livenessMs: 60_000,
  /**
   * Snapshot bytes core holds for one connection that the page hasn't
   * taken yet: past it, the snapshots in between are dropped, and each
   * query sends its latest once the page catches up.
   */
  unsentBytes: 512 * 1024,
} as const;

const lower = (set: number | undefined, most: number): number =>
  set !== undefined && Number.isInteger(set) && set > 0 && set < most
    ? set
    : most;

/**
 * The live-read budget (`querySubscriptionLimits.liveReads`), or a lower
 * one a test sets as `burst/perMinute` (core's `LIVE_READ_LIMITS`), so it
 * spends the budget in dozens of sandboxed reads instead of hundreds;
 * never higher.
 */
export const liveReadLimitsOf = (
  value: string | undefined
): { burst: number; perMinute: number } => {
  const [burst, perMinute] = (value ?? "").split("/").map(Number);
  const { liveReads } = querySubscriptionLimits;
  return {
    burst: lower(burst, liveReads.burst),
    perMinute: lower(perMinute, liveReads.perMinute),
  };
};

/**
 * What core pushes to a page following a query (`watchQuery`): the
 * query's result (spec 32.6's `OperationResult`, as a function call
 * answers it), numbered. Each push of one subscription has a greater
 * `revision` than the one before; a page drops any that doesn't.
 */
export interface QuerySnapshotPush {
  revision: number;
  result: unknown;
}

/**
 * What core pushes to a page following an App's current version
 * (`PagesApi.watchVersion`): the version current now (null while it
 * has none), read for the person; `recheck` when their access to the App,
 * or a build's delivery (its release revoked), may have dropped, so the page asks each frame's
 * build again (`PageFrameApi.delivery`). A refusal, the person having
 * lost the App or their session, is the last push.
 */
export type AppVersionPush =
  | { type: "current"; version: number | null; recheck: boolean }
  | { type: "refused"; error: { code: string; message: string } };

/**
 * A page's hold on updates it follows (a page's live query, its App's
 * version, a chat), until it releases it: then core calls its callback no
 * more.
 */
export interface SubscriptionApi {
  release: () => Promise<void>;
}

/**
 * One frame's way to its App, on the connection all of a tab's frames
 * share (`PagesApi.frame`): bound to the App, the build core leased the
 * frame and the person it was opened for. Each call is decided on that
 * build alone, never on what another frame of the App on the connection
 * runs: every call that reaches the App's data or runs is refused with
 * `page.revoked` once the release that build runs was revoked, or with
 * `page.unreviewed` when core leased the frame no build and the App's
 * data isn't `ordinary`, read before the call, before its answer and
 * before each push.
 * `close` (or letting go of the stub) releases everything the frame
 * follows through it, its live queries, at once;
 * a closed frame is refused every call (`page.invalid`).
 */
export interface PageFrameApi {
  /** Whether the frame's build gets the App's data now. */
  delivery: () => Promise<PageDelivery>;
  /**
   * What the trusted host decision UI shows the person before they
   * confirm the page's answer to the decision `decision` of one of the
   * runs the App started (`DecisionsApi.review`).
   */
  reviewDecision: (
    run: string,
    decision: string,
    answer: DecisionAnswerInput
  ) => Promise<DecisionReview>;
  /**
   * Mints the person's one-use confirmation of the page's answer, as
   * reviewed at `revision` (`DecisionsApi.confirm`), once they confirmed it
   * in the page's own dialog: the page's alone, never reached from the
   * frame. Audited as confirmed for a page.
   */
  confirmDecision: (
    run: string,
    decision: string,
    revision: string,
    answer: DecisionAnswerInput
  ) => Promise<DecisionConfirmation>;
  /**
   * Answers the decision `decision` of one of the runs the App started,
   * as the person, by the decision's own rules: only
   * someone it is from, and never the run's starter unless it names
   * exactly them, with the one-use confirmation the page minted once the
   * person confirmed exactly this answer (`DecisionsApi.confirm`); the
   * page never has it. Audited as answered on a page (`via: "page"`).
   */
  decide: (
    run: string,
    decision: string,
    answer: DecisionAnswerInput,
    confirmation?: string
  ) => Promise<DecisionView>;
  /**
   * Follows one of the App's public queries (spec 11): `request` is the
   * call as a function call sends it (its reference and input, as JSON
   * text). Core reads it as the person, pushes its result to `onSnapshot`
   * (`QuerySnapshotPush`), and pushes it again, read afresh, after every
   * commit that changed what it read, for as long as the person may use
   * the App and the build gets its data, until the page releases the
   * subscription. A refusal that ends the subscription (the person or the
   * build lost access, the App moved to another version) is pushed as the
   * last result; core then lets go of `onSnapshot`, as it does when it can
   * no longer keep the query fresh, which tells the page to follow
   * again. One connection follows at most 100 queries at once, and a
   * person 500 of one App (`page.too_many_queries`).
   */
  watchQuery: (
    request: string,
    onSnapshot: (snapshot: QuerySnapshotPush) => void
  ) => Promise<SubscriptionApi>;
  close: () => Promise<void>;
}

/**
 * A signed-in person's way to an App's pages: for anyone with a role in
 * the App (`AppsApi`); its error log for its builders only. What a page
 * then asks of its App goes through its frame (`frame`).
 */
export interface PagesApi {
  /**
   * The App's pages, built from its current version: refused with
   * `page.revoked` once the release of that version was revoked.
   * Refusals are audited, the same one once in a while. Counted against
   * what one person's pages of the App may ask (`page.rate_limited`).
   * Which route they show is the frame's router's: core never reads it.
   */
  open: (app: string) => Promise<PageBundle>;
  /**
   * The surfaces of the App's current version (spec 34.1), for someone
   * with a role in it, to place them. Opening one is `open`'s, at its
   * route.
   */
  surfaces: (app: string) => Promise<SurfaceSummary[]>;
  /**
   * The sidebar entries of the Apps the person has a role in: each App
   * with surfaces of kind `sidebar`, with those.
   */
  sidebar: () => Promise<SidebarApp[]>;
  /**
   * One frame's own way to the App (`PageFrameApi`), for the build the
   * lease `open` gave it: how frames that share a connection each get
   * their App's data on their own build, and let go of all they follow
   * when they close. A lease core didn't sign for this person and App
   * names no build: the frame is decided as code core didn't serve.
   */
  frame: (app: string, lease: string) => Promise<PageFrameApi>;
  /**
   * Follows the App's current version for the page (spec 11.5): one
   * subscription per App a tab's frames run, shared by all of them.
   * Core pushes the version current now to `onVersion` at once, again
   * each time another version is made current, and whenever the person's
   * access to the App may have dropped (`recheck`), each push read as
   * the person behind the connection then. Once they lost the App, the
   * last push is the refusal, and core lets go of `onVersion`; it lets go
   * of it, too, when it can no longer follow the App, which tells the
   * page to follow again. One connection follows at most 20 Apps at once
   * (`page.too_many_subscriptions`).
   */
  watchVersion: (
    app: string,
    onVersion: (push: AppVersionPush) => void
  ) => Promise<SubscriptionApi>;
  /**
   * Adds a problem in a page at `version` to the App's error log:
   * `page.rate_limited` past what one person's pages, or all of the
   * App's, may report a minute, whatever the report holds.
   */
  report: (
    app: string,
    at: { version: number; path: string },
    problem: PageProblem
  ) => Promise<void>;
  /** The App's error log. */
  errors: (app: string) => Promise<AppErrorLog>;
}

/** Why a call to an App's pages was refused. */
export const pageErrors = defineErrorFamily({
  "page.not_found": "The App has no such page.",
  "page.build_failed": "The App's pages don't build.",
  "page.build_slow":
    "The App's pages are still building. Try again in a moment.",
  "page.not_sealed":
    "This version's pages aren't sealed with its release, so they can't open.",
  "page.invalid": "That isn't a valid request for a page.",
  "page.too_many_subscriptions":
    "This page follows at most 20 workflows' runs at once. Close a page, then try again.",
  "page.too_many_queries":
    "This page follows too many live queries at once. Close a page, then try again.",
  "page.rate_limited":
    "This page asks for too much at once. Try again in a moment.",
  "page.answer_too_large":
    "The App answered with more data than a page takes in one call.",
  "page.unreviewed":
    "An admin hasn't opened this App's data to code outside Grasp.",
  "page.revoked": "This version of the App was revoked.",
  "page.review_outdated":
    "What the App's data is changed since it was read. Read it again.",
  "page.reload_required": "This page is out of date. Reload it to go on.",
  "page.access_changed":
    "Your access to this App changed. What it shows is being read again.",
});

/**
 * How long a page refused as `page.rate_limited` should wait before it
 * asks again: the time its request budget takes to give back one request.
 */
export const rateLimitedRetryMs = Math.ceil(
  60_000 / pageLimits.requests.perMinute
);

/**
 * `page.rate_limited`, with how long to wait before asking again
 * (`retryAfterMs`), so a client waits for the budget rather than spending
 * its retries while it is empty.
 */
export const rateLimited = () =>
  pageErrors.create("page.rate_limited", {
    retryAfterMs: rateLimitedRetryMs,
  });
