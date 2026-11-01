import { adminAskPath } from "@grasp-os/shared/admin-ask";
import { adminKickoffPath } from "@grasp-os/shared/admin-kickoff";
import { adminSnapshotPath } from "@grasp-os/shared/admin-snapshot";
import { aiStatusReportPath } from "@grasp-os/shared/ai-status-report";
import { auditExportPath } from "@grasp-os/shared/audit-log";
import { channelPlatformOf } from "@grasp-os/shared/channels";
import { connectionCallbackPath } from "@grasp-os/shared/connect";
import { errorReportPath } from "@grasp-os/shared/error-reports";
import { internalErrors, requestErrors } from "@grasp-os/shared/errors";
import { guestApiPath } from "@grasp-os/shared/guests";
import { requestIdHeader } from "@grasp-os/shared/http";
import { interviewHearPath } from "@grasp-os/shared/interview-hear";
import {
  interviewApiPath,
  interviewPagePath,
} from "@grasp-os/shared/interview-links";
import { interviewStoryPath } from "@grasp-os/shared/interview-story";
import { interviewTurnPath } from "@grasp-os/shared/interview-turn";
import { labPath } from "@grasp-os/shared/lab";
import { errorFields, log } from "@grasp-os/shared/log";
import type { LogFields } from "@grasp-os/shared/log";
import { mailIngressPath } from "@grasp-os/shared/mail-ingress";
import { onboardingSummaryPath } from "@grasp-os/shared/onboarding-summary";
import { platformUpdatePath } from "@grasp-os/shared/platform-change";
import {
  connectVersionPath,
  provisionProbePath,
} from "@grasp-os/shared/provision-probe";
import { screenFramePath } from "@grasp-os/shared/screens";
import { speechPath, transcriptionPath } from "@grasp-os/shared/voice";

import { adminAskResponse } from "./admin-ask.ts";
import { adminKickoffResponse } from "./admin-kickoff.ts";
import { adminSnapshotResponse } from "./admin-snapshot.ts";
import { aiStatusReportResponse } from "./ai-status-report.ts";
import { appFileResponse, fileRouteOf } from "./app-file-route.ts";
import {
  appFunctionRoute,
  portableCallApp,
  portableFunctionResponse,
} from "./app-function-route.ts";
import { appLinkResponse, linkRouteOf } from "./app-link-route.ts";
import { appTokenResponse, tokenRequestApp } from "./app-token-route.ts";
import { auditExportResponse } from "./audit-rpc.ts";
import { authBasePath } from "./auth/auth.ts";
import { signInConfig } from "./auth/config.ts";
import { handleAuthRequest } from "./auth/routes.ts";
import { installBuiltinsOnce } from "./builtins.ts";
import { ensureClockOnce } from "./clock.ts";
import {
  catalogLogoResponse,
  handleConnectionCallback,
  isCatalogLogoPath,
} from "./connections.ts";
import { errorReportResponse } from "./error-reports.ts";
import { errorResponse } from "./errors.ts";
import { guestResponse } from "./guests.ts";
import { originalResponse } from "./knowledge/uploads.ts";
import { mailIngressResponse } from "./mail-ingress.ts";
import { hearResponse } from "./onboarding/hear.ts";
import { interviewTurnResponse } from "./onboarding/interview.ts";
import { labResponse } from "./onboarding/lab.ts";
import { interviewResponse } from "./onboarding/links.ts";
import { speechResponse } from "./onboarding/speech.ts";
import { interviewStoryResponse } from "./onboarding/story.ts";
import { onboardingSummaryResponse } from "./onboarding/summary.ts";
import { transcriptionResponse } from "./onboarding/transcription.ts";
import {
  packageArtifactResponse,
  withoutArtifactToken,
} from "./packages/serve.ts";
import { platformUpdateResponse } from "./platform-updates.ts";
import { liveConnectionApp, portableLiveResponse } from "./portable-live.ts";
import {
  connectVersionResponse,
  provisionProbeResponse,
} from "./provision-probe.ts";
import { checkRouterSecret } from "./router-secret.ts";
import { rpcResponse } from "./rpc.ts";
import { screenFrameResponse, screenModuleResponse } from "./screen-frame.ts";
import {
  isRefusedToProductPage,
  setSecurityHeaders,
} from "./security-headers.ts";
import {
  runFileResponse,
  runFileRouteOf,
} from "./workflows/run-file-downloads.ts";

const isUnder = (pathname: string, base: string): boolean =>
  pathname === base || pathname.startsWith(`${base}/`);

/** An escaped `/` or `\`, which decoding turns into a path separator. */
const escapedSeparator = /%(?:2f|5c)/iu;

/**
 * Whether `pathname` (as the URL parser left it) means another path once
 * decoded: an escaped separator, or a segment that decodes to `.` or `..`.
 */
const isAmbiguousPath = (pathname: string): boolean =>
  escapedSeparator.test(pathname) ||
  pathname.split("/").some((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return decoded === "." || decoded === "..";
  });

/**
 * A file the frontend's build named by its content's hash (Vite's
 * `assets/<name>-<hash>.<ext>`): it never changes under that name.
 */
const hashedAsset = /^\/assets\/[^/]+-[\w-]{8,}\.[a-z\d]+$/iu;

/** Seconds a hashed file may be kept: a year, as long as caches keep anything. */
const hashedAssetMaxAge = 31_536_000;

/**
 * How long a browser may keep `page`, served at `pathname`. A deployment
 * in a dispatch namespace answers every static file `max-age=0` (GRA-430),
 * so core says it: a hashed file for a year, unchanged; any page
 * (index.html, for the frontend's own routes too, and for a hashed name
 * that isn't there) only once checked again, so a release reaches everyone
 * on their next load.
 */
const cacheControlOf = (pathname: string, page: Response): string | null => {
  if (!page.ok) {
    return null;
  }
  const html = page.headers.get("content-type")?.includes("text/html") ?? false;
  if (html) {
    return "no-cache";
  }
  return hashedAsset.test(pathname)
    ? `public, max-age=${hashedAssetMaxAge}, immutable`
    : null;
};

/** The frontend's files; unknown paths get index.html (single-page app). */
const pageResponse = async (
  pathname: string,
  request: Request,
  env: Env
): Promise<Response> => {
  const page = await env.ASSETS.fetch(request);
  if (pathname !== interviewPagePath) {
    const cacheControl = cacheControlOf(pathname, page);
    if (cacheControl === null) {
      return page;
    }
    const cached = new Response(page.body, page);
    cached.headers.set("cache-control", cacheControl);
    return cached;
  }
  // The interview's page carries its link's secret: no referrer, whatever
  // it links to, and no copy kept.
  const kept = new Response(page.body, page);
  kept.headers.set("referrer-policy", "no-referrer");
  kept.headers.set("cache-control", "no-store");
  return kept;
};

/**
 * The frontend's files; unknown paths get index.html (single-page app).
 * Never at a path the browser and the static files would read
 * differently: the browser matches the page's policy on the path as
 * written, so `/assets/..%2Fscreen-modules/…` passes as one of the
 * frontend's files, while the static files decode it into another path,
 * from which core would answer. No file of the frontend has such a path.
 */
const frontendResponse = async (
  pathname: string,
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (isAmbiguousPath(pathname)) {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  return await pageResponse(pathname, request, env);
};

/** `/api/knowledge/uploads/<id>/original`: an upload's original. */
const originalPath = /^\/api\/knowledge\/uploads\/(?<id>[\w-]+)\/original$/u;

/**
 * The pages a link opens, which have no session: the link's secret in the
 * body is all they have. A guest's (src/guests.ts), and someone's own
 * interview, with the device's key too (src/onboarding/links.ts), whose
 * lines are said at the speech endpoint, and what they say is written down
 * over a WebSocket, both also for an admin signed in
 * (src/onboarding/speech.ts, src/onboarding/transcription.ts).
 */
const linkResponse = async (
  pathname: string,
  request: Request,
  env: Env,
  requestId: string,
  ctx: Pick<ExecutionContext, "waitUntil">
): Promise<Response | undefined> => {
  if (pathname === guestApiPath) {
    return await guestResponse(request, env, requestId);
  }
  if (pathname === interviewApiPath) {
    return await interviewResponse(request, env, requestId);
  }
  if (pathname === interviewTurnPath) {
    return await interviewTurnResponse(request, env, requestId, ctx);
  }
  if (pathname === interviewStoryPath) {
    return await interviewStoryResponse(request, env, requestId, ctx);
  }
  if (pathname === speechPath) {
    return await speechResponse(request, env, requestId);
  }
  if (pathname === transcriptionPath) {
    return transcriptionResponse(request, env, requestId, ctx);
  }
  if (pathname === interviewHearPath) {
    return await hearResponse(request, env, requestId);
  }
  return undefined;
};

/**
 * The code screens' frames load: screens' modules and Apps' npm packages,
 * never to the product page itself (`isRefusedToProductPage`).
 */
const frameCodeResponse = async (
  request: Request,
  env: Env,
  url: URL,
  requestId: string
): Promise<Response | null> => {
  if (isRefusedToProductPage(request)) {
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }
  const screenModule = await screenModuleResponse(env, url);
  if (screenModule !== null) {
    return screenModule;
  }
  return await packageArtifactResponse(env, request);
};

/**
 * The connection routes: a provider's OAuth callback, and a catalog app's
 * logo. Undefined for any other path, and for a callback that isn't one.
 */
const connectionRouteResponse = async (
  request: Request,
  env: Env,
  pathname: string,
  requestId: string,
  ctx: Pick<ExecutionContext, "waitUntil">
): Promise<Response | undefined> => {
  if (pathname === connectionCallbackPath) {
    // Someone who connected from a chat app is told there, and what they
    // asked is answered again, after the browser is sent on.
    return await handleConnectionCallback(request, env, (userId) => {
      // The channel layer, and the Chat SDK with it, loads when first used,
      // not as core starts (GRA-1349).
      const carryOn = async (): Promise<void> => {
        const { carryOnAfterConnecting } = await import("./channels/answer.ts");
        await carryOnAfterConnecting(env, userId);
      };
      ctx.waitUntil(carryOn());
    });
  }
  if (isCatalogLogoPath(pathname)) {
    return await catalogLogoResponse(request, env, pathname, requestId);
  }
  return undefined;
};

/**
 * A call of an App's functions, from a screen's page or a portable host,
 * a portable host's live connection, or its token request, or a
 * screen's file channel request (app-file-route.ts); `undefined` for any
 * other path.
 */
const appCallResponse = async (
  pathname: string,
  request: Request,
  env: Env,
  requestId: string
): Promise<Response | undefined> => {
  // A screen's call of one of its App's functions, or of a streaming
  // action's (`<path>/<app>/<stream | attach | cancel>`).
  const screenCall = await appFunctionRoute(request, env, pathname, requestId);
  if (screenCall !== undefined) {
    return screenCall;
  }
  const portableApp = portableCallApp(pathname);
  if (portableApp !== undefined) {
    return await portableFunctionResponse(request, env, portableApp, requestId);
  }
  const liveApp = liveConnectionApp(pathname);
  if (liveApp !== undefined) {
    return portableLiveResponse(request, env, liveApp, requestId);
  }
  const tokenApp = tokenRequestApp(pathname);
  if (tokenApp !== undefined) {
    return await appTokenResponse(request, env, tokenApp, requestId);
  }
  const linkRoute = linkRouteOf(pathname, request.method);
  if (linkRoute === "not_found") {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  if (linkRoute !== undefined) {
    return await appLinkResponse(request, env, linkRoute, requestId);
  }
  // A run's finished file, downloaded from its run sheet.
  const runFile = runFileRouteOf(pathname);
  if (runFile !== undefined) {
    return await runFileResponse(request, env, runFile, requestId);
  }
  const fileRoute = fileRouteOf(pathname, request.method);
  if (fileRoute === "not_found") {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  return fileRoute === undefined
    ? undefined
    : await appFileResponse(request, env, fileRoute, requestId);
};

/** The routes at one path whose handler takes the request alone. */
const pathHandlers: ReadonlyMap<
  string,
  (request: Request, env: Env, requestId: string) => Promise<Response>
> = new Map([
  [auditExportPath, auditExportResponse],
  [errorReportPath, errorReportResponse],
  [onboardingSummaryPath, onboardingSummaryResponse],
  [aiStatusReportPath, aiStatusReportResponse],
  [adminSnapshotPath, adminSnapshotResponse],
  [adminAskPath, adminAskResponse],
  [adminKickoffPath, adminKickoffResponse],
  [platformUpdatePath, platformUpdateResponse],
  [mailIngressPath, mailIngressResponse],
]);

/**
 * The admin's signed requests, by path: each answers only a request the
 * admin signed, and undefined for anything else.
 */
const adminSignedHandlers: ReadonlyMap<
  string,
  (request: Request, env: Env) => Promise<Response | undefined>
> = new Map([
  [provisionProbePath, provisionProbeResponse],
  [connectVersionPath, connectVersionResponse],
]);

/** Routes a request that has passed the router-secret check. */
const route = async (
  request: Request,
  env: Env,
  requestId: string,
  ctx: Pick<ExecutionContext, "waitUntil">
): Promise<Response> => {
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname === "/health") {
    // The version answering, where there is version metadata: the admin's
    // smoke check compares it with the version it just deployed. Behind the
    // router-secret check, as every route is.
    const version = env.CF_VERSION_METADATA?.id;
    return Response.json(
      version === undefined ? { ok: true } : { ok: true, version }
    );
  }
  if (pathname === "/rpc") {
    return await rpcResponse(request, env, requestId);
  }
  // The admin's alone, the probe and connect's version: anyone else's
  // request goes on as one to a path core has no route for
  // (src/provision-probe.ts).
  const signed = adminSignedHandlers.get(pathname);
  if (signed !== undefined) {
    const answer = await signed(request, env);
    if (answer !== undefined) {
      return answer;
    }
  }
  if (pathname === screenFramePath) {
    return await screenFrameResponse(env, url);
  }
  const frameCode = await frameCodeResponse(request, env, url, requestId);
  if (frameCode !== null) {
    return frameCode;
  }
  if (isUnder(pathname, authBasePath)) {
    return await handleAuthRequest(request, env, requestId);
  }
  const connection = await connectionRouteResponse(
    request,
    env,
    pathname,
    requestId,
    ctx
  );
  if (connection !== undefined) {
    return connection;
  }
  const handler = pathHandlers.get(pathname);
  if (handler !== undefined) {
    return await handler(request, env, requestId);
  }
  if (pathname === labPath) {
    return await labResponse(request, env, requestId, ctx);
  }
  const linked = await linkResponse(pathname, request, env, requestId, ctx);
  if (linked !== undefined) {
    return linked;
  }
  // A chat platform's webhook (src/channels/door.ts), which only the
  // platform's own signed requests get through.
  const platform = channelPlatformOf(pathname);
  if (platform !== undefined) {
    const { channelResponse } = await import("./channels/door.ts");
    return await channelResponse(request, env, platform, requestId, ctx);
  }
  const appCall = await appCallResponse(pathname, request, env, requestId);
  if (appCall !== undefined) {
    return appCall;
  }
  const original = originalPath.exec(pathname)?.groups?.id;
  if (original !== undefined) {
    return await originalResponse(request, env, original, requestId);
  }
  if (isUnder(pathname, "/api")) {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  return await frontendResponse(pathname, request, env, requestId);
};

/** A response, and what the request's log line says about it. */
interface Outcome {
  response: Response;
  level: keyof typeof log;
  fields?: LogFields;
}

const respond = async (
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  requestId: string
): Promise<Outcome> => {
  try {
    const checked = await checkRouterSecret(request, env);
    if (checked.ok) {
      installBuiltinsOnce(env, ctx);
      ensureClockOnce(env, ctx);
      const response = await route(checked.request, env, requestId, ctx);
      return { response, level: "info" };
    }
    const response = errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
    // A missing secret on core's side refuses everything: that's an error.
    const level = checked.reason === "not_configured" ? "error" : "warn";
    return { response, level, fields: { refused: checked.reason } };
  } catch (error) {
    // A body that took too long to arrive (`readAtMost`): the client's
    // doing, answered as such wherever it was read.
    if (requestErrors.codeOf(error) === "request.timeout") {
      const response = errorResponse(
        408,
        requestErrors.create("request.timeout"),
        requestId
      );
      return { response, level: "warn", fields: { refused: "timeout" } };
    }
    const response = errorResponse(
      500,
      internalErrors.create("internal.unexpected"),
      requestId
    );
    return { response, level: "error", fields: errorFields(error) };
  }
};

/**
 * Headers of a response from a binding are immutable, so it is copied. A
 * WebSocket upgrade can't be copied, but core builds that one itself.
 */
const withRequestId = (response: Response, requestId: string): Response => {
  const tagged = response.webSocket
    ? response
    : new Response(response.body, response);
  tagged.headers.set(requestIdHeader, requestId);
  return tagged;
};

/** Every request to core starts here, static files included. */
export const handleRequest = async (
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">
): Promise<Response> => {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  const { response, level, fields } = await respond(
    request,
    env,
    ctx,
    requestId
  );
  // One line per request. Only the path: query strings can carry tokens,
  // and so can an artifact's path, without it.
  log[level]("request", {
    requestId,
    method: request.method,
    path: withoutArtifactToken(url.pathname),
    status: response.status,
    durationMs: Date.now() - startedAt,
    ...fields,
  });
  const tagged = withRequestId(response, requestId);
  // On every response, not only the frontend's: a route added later that
  // serves HTML is covered too.
  setSecurityHeaders(
    tagged.headers,
    url,
    signInConfig(env)?.origin ?? url.origin
  );
  return tagged;
};
