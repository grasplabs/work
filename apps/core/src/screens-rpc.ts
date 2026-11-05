// oxlint-disable max-classes-per-file -- a connection's screens, and each frame's own way to its App on that connection, which shares its checks
import { schemaFromDescriptor } from "@grasp-os/sdk/host";
import type { AppManifest } from "@grasp-os/sdk/host";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { appErrors, appVersionSchema } from "@grasp-os/shared/apps";
import type { App } from "@grasp-os/shared/apps";
import type {
  DecisionConfirmation,
  DecisionReview,
  DecisionView,
} from "@grasp-os/shared/decisions";
import { authErrors, isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import {
  jsonOf,
  jsonWithin,
  operationErrors,
} from "@grasp-os/shared/operations";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  jsonBytes,
  rateLimited,
  rateLimitedRetryMs,
  screenErrors,
  screenLimits,
  screenNameSchema,
  screenPath,
  screenProblemSchema,
  screenRouteSchema,
} from "@grasp-os/shared/screens";
import type {
  ScreenDelivery,
  AppErrorLog,
  AppVersionPush,
  QuerySnapshotPush,
  ScreenBundle,
  ScreenRoute,
  ScreenFrameApi,
  ScreensApi,
  ScreenTarget,
  SidebarApp,
  SurfaceSummary,
  TargetSurface,
} from "@grasp-os/shared/screens";
import { TokenBuckets } from "@grasp-os/shared/token-bucket";
import { z } from "zod";

import { asksPreferenceWindow, windowExtentOf } from "./app-functions.ts";
import { heldManifest, versionReferenceSource } from "./app-releases.ts";
import {
  appFor,
  findVersion,
  getApp,
  listApps,
  screensIn,
  usableApp,
  versionFiles,
} from "./apps.ts";
import type { ReferenceSource } from "./draft-references.ts";
import { appHost } from "./durable-objects.ts";
import { isStub } from "./page-callbacks.ts";
import type { PageCallback, StillOpen } from "./page-callbacks.ts";
import { QuerySubscriptions, screenReads } from "./query-subscriptions.ts";
import { windowPages } from "./query-windows.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import {
  deliveryOf,
  deliveryAt,
  delivering,
  leasedBuild,
  leaseFor,
  requireDelivery,
  standingOf,
} from "./screen-delivery.ts";
import type { LeasedBuild } from "./screen-delivery.ts";
import { frameAccess, stageFrame } from "./screen-frame.ts";
import { versionScreenCodes } from "./screen-references.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { Subscription } from "./subscription.ts";
import {
  confirmScreenDecision,
  decideScreenRun,
  reviewScreenDecision,
} from "./workflows/screen-decisions.ts";

// What the frontend's screen host reaches for the frames it runs (see
// @grasp-os/sdk/screen-runtime): an App's screen to load, its server to
// call and its current version. Next to them, never on the frame bridge
// and for the App's builders only, its error log (`errors`): its screens'
// problems and what its server code wrote with `console`
// (server-logs.ts). Screens run code nobody
// reviewed line by line, which the page passes on as it is, so everything
// here takes the frame's input as untrusted and checks the person's
// session and role on every call.
//
// What a screen may ask is bounded here and in the App's host, never only
// on the page, which a person can change: each person's requests of an
// App and its screens' reports by rate (`admitted`, `reportProblem`), an
// answer by its size in bytes (`withinAnswer`). Who is asking is always the session core checked; a
// screen names only its App, and has a role in it or is refused.
//
// Anyone with a role in the App (app-access.ts) uses its screens: opens
// them, calls its functions, reports problems, and starts, follows and
// answers its workflow runs (workflows/screen-runs.ts). Only its builders
// read its error log.
//
// A screen's build needs nobody's approval: it reaches only its App's
// functions, as its viewer (screen-delivery.ts says why that is enough).
// What still keeps the App's data from a screen is its release revoked,
// or a frame core leased no build: every call here that reaches the App's
// data or its runs passes that gate, and so does every push; only a screen's own reports of its
// problems, the App's version number and its error log, which only its
// builders read and no frame reaches, don't. Which build a frame runs is the one
// core leased it (`frame`), never what the frame says.
//
// A callback the App keeps (a screen's subscription) outlives the call
// that passed it, so each push through it checks again that the person
// still has a role in the App (`stillHasRole`), once per reading of the
// connection's session (at most every `sessionRecheckMs`) per App and
// connection. Once they don't (signed out, unshared, a team left, a role
// changed, a source they can't read), the callback is released and
// forwards nothing more: losing access stops a screen within a few
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
 * this request of theirs: `screen.rate_limited` past what one person's
 * screens of an App may ask (`screenLimits.requests`).
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
 * What charges `by` for a paginated list's pages of App `app`, past what
 * its request paid (query-windows.ts): `pages` more of their requests,
 * or `screen.rate_limited` with how long to wait: long enough for the
 * budget to give back all of them and the request asking again, so a
 * caller that waits as told isn't refused again for the same window.
 */
export const windowCharger =
  (env: Env, by: Identity, app: AppId) =>
  async (pages: number, whole = pages): Promise<void> => {
    if (!(await appHost(env, app).admitRequest(by.userId, pages))) {
      throw screenErrors.create("screen.rate_limited", {
        retryAfterMs: rateLimitedRetryMs * (whole + 1),
      });
    }
  };

/**
 * Counts a request for a paginated list's window (`request`, as its
 * caller sent it) as the pages the window takes: the one request
 * `admitted` counted, and one more for every page past the first. A
 * request without a window counts nothing more.
 */
export const admitWindow = async (
  env: Env,
  by: Identity,
  app: AppId,
  request: unknown
): Promise<void> => {
  // Refused before anything is charged: there is no window of one
  // document (app-preferences.ts).
  if (asksPreferenceWindow(request)) {
    throw operationErrors.create("contract.invalid_request");
  }
  const extent = windowExtentOf(request);
  const more = extent === undefined ? 0 : windowPages(extent) - 1;
  if (more > 0) {
    await windowCharger(env, by, app)(more);
  }
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

/** `answer`, if it is no more than a screen takes in one call. */
export const withinAnswer = <Answer>(answer: Answer): Answer => {
  if (jsonBytes(answer, screenLimits.answerBytes) > screenLimits.answerBytes) {
    throw screenErrors.create("screen.answer_too_large");
  }
  return answer;
};

/** A screen's route, as its version's manifest declares it (spec 8). */
type RouteManifest = AppManifest["screens"][string];

/** A surface, as its version's manifest declares it (spec 34.1). */
type SurfaceManifest = AppManifest["surfaces"][string];

/** What has an input schema to normalize with: a route, or a surface. */
type InputManifest = RouteManifest | SurfaceManifest;

/**
 * What a navigation or an opening names: a route, its input, and one of
 * its screen's declared surfaces, if any.
 */
const screenRouteRequestSchema = z.strictObject({
  route: screenRouteSchema,
  input: z.unknown().optional(),
  surface: screenRouteSchema.optional(),
  /**
   * Asked for by a deep link, which anyone can write: only a surface the
   * App declares as a deep link opens from one.
   */
  deepLink: z.literal(true).optional(),
});

/** Each route's or surface's input schema, read once from its descriptor. */
const routeSchemas = new WeakMap<
  InputManifest,
  ReturnType<typeof schemaFromDescriptor>
>();

/** The most issues a refused screen input names. */
const maxInputIssues = 10;

/**
 * `input` as `route`'s schema normalizes it (defaults filled in, strings
 * trimmed), an omitted input as `{}`, as an operation's arguments are
 * (spec 10.7.7): read as JSON within `navigationInputBytes`, then
 * validated by the native validator. `screen.input_too_large` or
 * `screen.input_invalid` otherwise, naming what is wrong.
 */
const routeInput = (route: InputManifest, input?: unknown): Json => {
  // Only input left out is `{}`: `null` is input, and refused as one.
  const read = jsonWithin(
    input === undefined ? {} : input,
    screenLimits.navigationInputBytes
  );
  if (read === "too_large") {
    throw screenErrors.create("screen.input_too_large");
  }
  if (read === undefined) {
    throw screenErrors.create("screen.input_invalid", {
      issues: ["The input isn't JSON"],
    });
  }
  let schema = routeSchemas.get(route);
  if (schema === undefined) {
    schema = schemaFromDescriptor(JSON.stringify(route.input));
    routeSchemas.set(route, schema);
  }
  const result = schema["~standard"].validate(read.json);
  if (result instanceof Promise) {
    throw new TypeError("A route's schema validates asynchronously");
  }
  if (result.issues !== undefined) {
    throw screenErrors.create("screen.input_invalid", {
      issues: result.issues
        .slice(0, maxInputIssues)
        .map(({ message }) => message),
    });
  }
  const normalized = jsonOf(result.value);
  if (normalized === undefined) {
    throw new TypeError("A validated screen input isn't JSON");
  }
  // Defaults fill it in: what the page carries, and opening checks again,
  // stays within the same bound.
  if (
    jsonWithin(normalized, screenLimits.navigationInputBytes) === "too_large"
  ) {
    throw screenErrors.create("screen.input_too_large");
  }
  return normalized;
};

/** The route `name` of `manifest`, and the screen file it opens. */
const routeNamed = (
  manifest: AppManifest | undefined,
  name: string
): { route: RouteManifest; file: string } => {
  const route =
    manifest !== undefined && Object.hasOwn(manifest.screens, name)
      ? manifest.screens[name]
      : undefined;
  const file =
    route === undefined
      ? undefined
      : screenPath.exec(route.source)?.groups?.name;
  if (route === undefined || file === undefined) {
    throw screenErrors.create("screen.not_found");
  }
  return { route, file };
};

/**
 * The surface `name` of `manifest`, declared for `route`'s screen; only a
 * surface the version's own manifest declares for that screen, so a name
 * from anywhere else (another screen's, another App's, a prototype key)
 * is refused (`screen.not_found`).
 */
const surfaceNamed = (
  manifest: AppManifest | undefined,
  route: RouteManifest,
  name: string
): SurfaceManifest => {
  const surface =
    manifest !== undefined && Object.hasOwn(manifest.surfaces, name)
      ? manifest.surfaces[name]
      : undefined;
  if (surface === undefined || surface.screen !== route.name) {
    throw screenErrors.create("screen.not_found");
  }
  return surface;
};

/**
 * Where `asked` goes in `manifest`: its route and screen file, its input
 * normalized, and its surface, if it names one. A surface's input is
 * checked with the surface's own schema first, then with its screen's,
 * so the screen gets nothing its route refuses whatever the surface took.
 * `carried` is what the page carries to open it again: the route's input,
 * or the surface's, as the surface's own schema normalized it, which
 * opening checks with both again.
 */
const resolvedRoute = (
  manifest: AppManifest | undefined,
  asked: z.infer<typeof screenRouteRequestSchema>
): {
  route: RouteManifest;
  file: string;
  input: Json;
  carried: Json;
  surface?: TargetSurface;
} => {
  const { route, file } = routeNamed(manifest, asked.route);
  if (asked.deepLink === true && asked.surface === undefined) {
    throw screenErrors.create("screen.not_found");
  }
  if (asked.surface === undefined) {
    const input = routeInput(route, asked.input);
    return { route, file, input, carried: input };
  }
  const surface = surfaceNamed(manifest, route, asked.surface);
  if (asked.deepLink === true && surface.kind !== "deepLink") {
    throw screenErrors.create("screen.not_found");
  }
  const carried = routeInput(surface, asked.input);
  return {
    route,
    file,
    input: routeInput(route, carried),
    carried,
    surface: { name: surface.name, kind: surface.kind, title: surface.title },
  };
};

/**
 * The route screen file `file` opens by, and its input: the route `asked`
 * names (it must open that file), with its input normalized; or, asked
 * for none, the first route of the file, in the order declared, whose
 * input may be left out (empty or all defaults), with that normalized.
 * `{}` and no route for a file no route names, or a version not of spec
 * 8's layout. A file whose every route needs input is refused
 * (`screen.input_invalid`): it opens only by navigating to it.
 */
const routedOpen = (
  manifest: AppManifest | undefined,
  file: string,
  asked?: z.infer<typeof screenRouteRequestSchema>
): { route: string | null; input: Json } => {
  if (asked !== undefined) {
    const named = resolvedRoute(manifest, asked);
    if (named.file !== file) {
      throw screenErrors.create("screen.not_found");
    }
    return { route: named.route.name, input: named.input };
  }
  const routes = Object.values(manifest?.screens ?? {}).filter(
    ({ source }) => source === `screens/${file}.tsx`
  );
  if (routes.length === 0) {
    return { route: null, input: {} };
  }
  let refusal: unknown;
  for (const route of routes) {
    try {
      return { route: route.name, input: routeInput(route) };
    } catch (error) {
      // Only an input refusal moves on to the next route; anything else
      // is a fault, not a reason to try another.
      if (!isExpectedError(error)) {
        throw error;
      }
      refusal = error;
    }
  }
  throw refusal;
};

/** Why a version's server code yields no manifest to route by. */
const unroutedCodes: ReadonlySet<string> = new Set([
  "version.build_failed",
  "version.inspection_failed",
  "version.invalid_manifest",
]);

/**
 * What a version's screens route by and generate their references from:
 * its manifest and bound workflows (`versionReferenceSource`); undefined
 * for a version not of spec 8's layout, or whose server code doesn't
 * inspect, which routes nothing.
 */
const routeSourceOf = async (
  env: Env,
  app: AppId,
  version: number,
  files: Record<string, string>
): Promise<ReferenceSource | undefined> => {
  try {
    return await versionReferenceSource(env, app, version, files);
  } catch (error) {
    // Only server code that doesn't build or inspect routes nothing; a
    // sealed release that fails its checks is refused as itself.
    if (unroutedCodes.has(versionErrors.codeOf(error) ?? "")) {
      return undefined;
    }
    throw error;
  }
};

/**
 * A running App's screen, built from its current version, with core's
 * lease on that build for the person: only a build that gets the App's
 * data now (its release not revoked), once this request of theirs is
 * counted (`admitted`). One that
 * doesn't is refused before its code is where a frame can load it; one
 * that does is put there (`stageFrame`). With the input its route takes
 * (`routedOpen`), checked before anything is built: the screen gets only
 * what its route's schema normalized.
 */
const openScreen = async (
  env: Env,
  by: Identity,
  app: unknown,
  screen: unknown,
  route?: unknown
): Promise<ScreenBundle> => {
  const {
    id,
    name: appName,
    currentVersion: version,
  } = await admittedApp(env, by, app);
  // A name that can't be a screen's is refused before `app.not_running`.
  const file = screenErrors.parse("screen.invalid", screenNameSchema, screen);
  const asked =
    route === undefined
      ? undefined
      : screenErrors.parse("screen.invalid", screenRouteRequestSchema, route);
  if (version === null) {
    throw appErrors.create("app.not_running");
  }
  const raw = await versionFiles(env, id, version);
  const source = await routeSourceOf(env, id, version, raw);
  const opened = routedOpen(source?.manifest, file, asked);
  const built = await (
    await versionScreenCodes(env, id, version, raw, { unsealed: "refuse" })
  )(file);
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
    screen: built.screen,
    route: opened.route,
    input: opened.input,
    artifact,
    frameToken: await frameAccess(env, artifact),
    lease: await leaseFor(env, by.userId, id, build),
  };
};

/**
 * Where a visitor's visit opens, chosen by route before by screen: the
 * route at `/`, else the first route the App declares with no parameters
 * whose input is complete with none, and that route's screen. A version
 * that routes nothing opens its first screen by name. Undefined when
 * nothing opens without input: a visitor has no link to give one.
 */
const visitorEntry = (
  manifest: AppManifest | undefined,
  screens: readonly string[]
): { file: string; route: string | null; input: Json } | undefined => {
  const routes = Object.values(manifest?.screens ?? {});
  if (routes.length === 0) {
    const [file] = screens;
    return file === undefined ? undefined : { file, route: null, input: {} };
  }
  const candidates = [
    ...routes.filter(({ path }) => path === "/"),
    ...routes.filter(({ path }) => path !== "/" && !path.includes("/:")),
  ];
  for (const route of candidates) {
    const file = screenPath.exec(route.source)?.groups?.name;
    if (file !== undefined && screens.includes(file)) {
      try {
        return { file, route: route.name, input: routeInput(route) };
      } catch (error) {
        // A route whose input needs more than none: the next one.
        if (!isExpectedError(error)) {
          throw error;
        }
      }
    }
  }
  return undefined;
};

/**
 * The entry screen of a published App's current version, for a visitor
 * (app-visitors.ts, `visitorEntry`): built and staged as `openScreen`
 * does, once its build gets the App's data now, and leased to `visitor`
 * (`visitor:<session>`), a name no member's session has, so the lease
 * opens none of the App's functions (app-function-route.ts needs a
 * member's session too). Null while the App runs no version or has no
 * screen that opens without input.
 */
export const visitorScreen = async (
  env: Env,
  found: Pick<App, "id" | "name" | "currentVersion">,
  visitor: string
): Promise<ScreenBundle | null> => {
  const { id, name: appName, currentVersion: version } = found;
  if (version === null) {
    return null;
  }
  const raw = await versionFiles(env, id, version);
  const source = await routeSourceOf(env, id, version, raw);
  const opened = visitorEntry(
    source?.manifest,
    screensIn(new Map(Object.entries(raw)))
  );
  if (opened === undefined) {
    return null;
  }
  const { file } = opened;
  const built = await (
    await versionScreenCodes(env, id, version, raw, { unsealed: "refuse" })
  )(file);
  const { artifact } = built;
  const build = { artifact, version };
  if (deliveryOf(await standingOf(env, id, build)) !== "open") {
    throw screenErrors.create("screen.revoked");
  }
  await stageFrame(env, artifact, built.code);
  return {
    app: id,
    name: appName,
    version,
    screen: built.screen,
    route: opened.route,
    input: opened.input,
    artifact,
    frameToken: await frameAccess(env, artifact),
    lease: await leaseFor(env, visitor, id, build),
  };
};

/**
 * Where a screen of App `app` may go (spec 10.7.7): the screen route
 * `request.route` names at the App's current version, with its input
 * normalized, once this request of the person's is counted (`admitted`)
 * and the screen's build gets the App's data now, as `openScreen` decides
 * it. Nothing is built for a frame or leased: the page opens the screen
 * after, and `openScreen` checks all of it again.
 */
const navigateScreen = async (
  env: Env,
  by: Identity,
  app: unknown,
  request: unknown
): Promise<ScreenTarget> => {
  const { id, currentVersion: version } = await admittedApp(env, by, app);
  const asked = screenErrors.parse(
    "screen.invalid",
    screenRouteRequestSchema,
    request
  );
  if (version === null) {
    throw appErrors.create("app.not_running");
  }
  const raw = await versionFiles(env, id, version);
  const source = await routeSourceOf(env, id, version, raw);
  const { route, file, carried, surface } = resolvedRoute(
    source?.manifest,
    asked
  );
  const built = await (
    await versionScreenCodes(env, id, version, raw, { unsealed: "refuse" })
  )(file);
  await requireDelivery(
    env,
    by,
    id,
    { artifact: built.artifact, version },
    {
      operation: "navigate",
      stage: "admission",
    }
  );
  return {
    screen: built.screen,
    route: route.name,
    input: carried,
    ...(surface === undefined ? {} : { surface }),
  };
};

/** Whether `surface` opens with nothing: its input schema takes `{}`. */
const opensEmpty = (surface: SurfaceManifest): boolean => {
  try {
    routeInput(surface);
    return true;
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    throw error;
  }
};

/** The surfaces `manifest` declares, as the host lists them to place them. */
const surfaceSummaries = (
  manifest: AppManifest | undefined
): SurfaceSummary[] =>
  Object.values(manifest?.surfaces ?? {})
    .toSorted((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((surface) => {
      const route = Object.hasOwn(manifest?.screens ?? {}, surface.screen)
        ? manifest?.screens[surface.screen]
        : undefined;
      const screen =
        route === undefined
          ? undefined
          : screenPath.exec(route.source)?.groups?.name;
      return route === undefined || screen === undefined
        ? []
        : [
            {
              name: surface.name,
              kind: surface.kind,
              title: surface.title,
              route: route.name,
              screen,
              opensEmpty: opensEmpty(surface),
            },
          ];
    });

/** The surfaces `version` of `app` declares. */
const versionSurfaces = async (
  env: Env,
  app: AppId,
  version: number
): Promise<SurfaceSummary[]> => {
  const raw = await versionFiles(env, app, version);
  const source = await routeSourceOf(env, app, version, raw);
  return surfaceSummaries(source?.manifest);
};

/**
 * The surfaces of `app`'s current version (spec 34.1), for someone with a
 * role in it: none while it has no version, or one that routes nothing.
 * Listing them opens nothing: each is opened, and checked, as any screen.
 */
const appSurfaces = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<SurfaceSummary[]> => {
  // Counted as one of the person's requests of the App, as opening is.
  const { id, currentVersion: version } = await admittedApp(env, by, app);
  return version === null ? [] : await versionSurfaces(env, id, version);
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
    // Only what core holds already: an App whose manifest it would have to
    // work out now shows no entries, rather than inspecting its code here.
    const raw = await versionFiles(env, app.id, app.currentVersion);
    const manifest = await heldManifest(env, app.id, app.currentVersion, raw);
    const listed = surfaceSummaries(manifest).filter(
      ({ kind }) => kind === "sidebar"
    );
    // A revoked release's screens get nothing: none of them is offered.
    // Opening one still checks it, whatever this says.
    const { releaseRevoked } = await standingOf(env, app.id);
    surfaces = releaseRevoked ? [] : listed;
  } catch (error) {
    if (!isExpectedError(error)) {
      log.warn("screen.sidebar_app_failed", {
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
 * of what core keeps (a sealed release, or a manifest kept by code hash),
 * so the listing never builds or runs App code twice.
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
 * Follows `app`'s current version for `by`'s page (`ScreensApi.watchVersion`,
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
        log.warn("screen.version_read_failed", {
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
  app: AppId
): Promise<boolean> => {
  try {
    await usableApp(env, by, app);
    return true;
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    throw error;
  }
};

/**
 * Whether the person behind the connection still has `role` in `app`
 * (any role: `user`), before each push: the connection's own session check
 * (`check`), the reading of their session, role and teams that every call
 * shares, Grasp staff's window included, then the App's rules (`appFor`),
 * read again with each new reading of the session and kept until the next.
 * So a push never rests on an older reading than a call would, and a
 * stream of pushes costs one look at the App's rules every few seconds.
 * Anything that goes wrong on the way is a no: a callback must not
 * outlive access because a check failed. A session that ended also closes
 * the connection, as on any call. For the callbacks of an App's screens,
 * and of a draft's preview (chats-rpc.ts).
 */
export const stillHasRole = (
  env: Env,
  check: SessionCheck,
  app: AppId,
  role: "user" | "builder" = "user"
): StillOpen => {
  const refused = (error: unknown): false => {
    if (!isExpectedError(error)) {
      log.error("screen.access_check_failed", {
        appId: app,
        ...errorFields(error),
      });
    }
    return false;
  };
  const hasRole = async (person: Identity): Promise<boolean> => {
    try {
      await usableApp(env, person, app, role);
      return true;
    } catch (error) {
      return refused(error);
    }
  };
  let latest: { person: Identity; open: Promise<boolean> } | undefined;
  return async () => {
    let person: Identity;
    try {
      person = await check();
    } catch (error) {
      return refused(error);
    }
    if (latest?.person !== person) {
      latest = { person, open: hasRole(person) };
    }
    return await latest.open;
  };
};

/** Where in a screen a problem happened, as the page reports it. */
const reportedAtSchema = z.strictObject({
  version: appVersionSchema,
  screen: screenNameSchema,
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
  const where = screenErrors.parse("screen.invalid", reportedAtSchema, at);
  const reported = screenErrors.parse(
    "screen.invalid",
    screenProblemSchema,
    problem
  );
  // One of the App's versions, or `app.version_not_found`.
  await findVersion(env, id, where.version);
  await appHost(env, id).logError({
    at: new Date().toISOString(),
    source: "screen",
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

/** What a frame's capability shares with its connection (`ScreensRpc`). */
interface FrameConnection {
  readonly env: Env;
  readonly check: SessionCheck;
  /** Who the frame was opened for. */
  readonly userId: string;
  readonly app: AppId;
  /** The build core leased the frame, if the lease was core's for them. */
  readonly build: LeasedBuild | undefined;
  /** The connection's live queries, bounded for the whole tab. */
  readonly queries: QuerySubscriptions;
}

/**
 * One frame's way to its App on the connection a tab's frames share
 * (`ScreensApi.frame`). Threat model, and how each is closed:
 *
 * - Frame A decided on frame B's build: every call is decided on the
 *   build this frame's own lease named, never on what another frame of
 *   the App runs, so a frame
 *   whose build was revoked is refused while another frame's goes on.
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
export class ScreenFrameRpc extends CoreRpcTarget implements ScreenFrameApi {
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

  /** Refuses once the frame closed (`screen.invalid`). */
  #open(): void {
    if (this.#closed) {
      throw screenErrors.create("screen.invalid");
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

  /**
   * `run`, once this request of the person's is counted (`admitted`), if
   * the frame's build gets the App's data now (`delivering`).
   */
  async #delivered<Answer>(
    operation: string,
    run: (by: Identity) => Promise<Answer>
  ): Promise<Answer> {
    const by = await this.#person();
    const { env, app, build } = this.#connection;
    const id = await admitted(env, by, app);
    return await delivering(env, by, id, build, operation, async () => {
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

  async delivery(): Promise<ScreenDelivery> {
    const by = await this.#person();
    const { env, app, build } = this.#connection;
    // The person's role in the App first, as every call's: someone who
    // lost it hears that, never how the App's build stands. Nobody's frame
    // of an archived App is delivered anything.
    const { id } = await usableApp(env, by, app);
    return deliveryOf(await standingOf(env, id, build));
  }

  async reviewDecision(
    run: string,
    decision: string,
    answer: unknown
  ): Promise<DecisionReview> {
    const { env, app, build } = this.#connection;
    return await this.#delivered(
      "reviewDecision",
      async (by) =>
        await reviewScreenDecision(
          env,
          by,
          { app, version: build?.version },
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
    const { env, app, build } = this.#connection;
    return await this.#delivered(
      "confirmDecision",
      async (by) =>
        await confirmScreenDecision(
          env,
          by,
          { app, version: build?.version },
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
    const { env, app, build } = this.#connection;
    return await this.#delivered(
      "decide",
      async (by) =>
        await decideScreenRun(
          env,
          by,
          { app, version: build?.version },
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
    const { env, app, build, queries } = this.#connection;
    // Following is a request like any other; what core then pushes is
    // not counted (query-subscriptions.ts bounds it).
    const id = await admitted(env, by, app);
    if (
      typeof request !== "string" ||
      request.length > functionRequestMaxBytes ||
      !isStub(onSnapshot)
    ) {
      throw screenErrors.create("screen.invalid");
    }
    // A window counts as the pages it reads (query-windows.ts).
    await admitWindow(env, by, id, request);
    await requireDelivery(env, by, id, build, {
      operation: "watchQuery",
      stage: "admission",
    });
    return await this.#hold((ended) =>
      queries.subscribe(by, id, build, request, onSnapshot, ended)
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
 * A signed-in person's `screens`. Like the other APIs of a session, every
 * call checks the session first and hands the identity that check returned
 * on; each function checks the person's role.
 */
export class ScreensRpc extends CoreRpcTarget implements ScreensApi {
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
      screenReads(env, check, async (by, app, build) => {
        if (!(await hasRoleNow(env, by, app))) {
          return "role";
        }
        return await deliveryAt(env, by, app, build, {
          operation: "watchQuery",
          stage: "push",
        });
      })
    );
  }

  async open(
    app: string,
    screen: string,
    route?: ScreenRoute
  ): Promise<ScreenBundle> {
    return await withPerson(
      this.#check,
      async (by) => await openScreen(this.#env, by, app, screen, route)
    );
  }

  async navigate(app: string, navigation: ScreenRoute): Promise<ScreenTarget> {
    return await withPerson(
      this.#check,
      async (by) => await navigateScreen(this.#env, by, app, navigation)
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

  async frame(app: string, lease: string): Promise<ScreenFrameRpc> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await usableApp(this.#env, by, app);
      // Core's own lease names the build, never the page or the frame; a
      // lease core didn't sign for them and this App names none, and is
      // decided as code core didn't serve.
      const build = await leasedBuild(this.#env, by.userId, id, lease);
      return new ScreenFrameRpc({
        env: this.#env,
        check: this.#check,
        userId: by.userId,
        app: id,
        build,
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
        throw screenErrors.create("screen.invalid");
      }
      if (this.#versionSubscriptions.size >= maxVersionSubscriptions) {
        throw screenErrors.create("screen.too_many_subscriptions");
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
    at: { version: number; screen: string },
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
