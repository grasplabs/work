import { auditExportPath } from "@grasp-os/shared/audit-log";
import { connectionCallbackPath } from "@grasp-os/shared/connect";
import { errorReportPath } from "@grasp-os/shared/error-reports";
import { internalErrors, requestErrors } from "@grasp-os/shared/errors";
import { guestApiPath } from "@grasp-os/shared/guests";
import { requestIdHeader } from "@grasp-os/shared/http";
import {
  interviewApiPath,
  interviewPagePath,
} from "@grasp-os/shared/interview-links";
import { errorFields, log } from "@grasp-os/shared/log";
import type { LogFields } from "@grasp-os/shared/log";
import { onboardingSummaryPath } from "@grasp-os/shared/onboarding-summary";
import { platformUpdatePath } from "@grasp-os/shared/platform-change";
import { screenFramePath } from "@grasp-os/shared/screens";

import { auditExportResponse } from "./audit-rpc.ts";
import { authBasePath } from "./auth/auth.ts";
import { signInConfig } from "./auth/config.ts";
import { handleAuthRequest } from "./auth/routes.ts";
import { installBuiltinsOnce } from "./builtins.ts";
import {
  catalogLogoResponse,
  handleConnectionCallback,
  isCatalogLogoPath,
} from "./connections.ts";
import { errorReportResponse } from "./error-reports.ts";
import { errorResponse } from "./errors.ts";
import { guestResponse } from "./guests.ts";
import { originalResponse } from "./knowledge/uploads.ts";
import { interviewResponse } from "./onboarding/links.ts";
import { onboardingSummaryResponse } from "./onboarding/summary.ts";
import {
  packageArtifactResponse,
  withoutArtifactToken,
} from "./packages/serve.ts";
import { platformUpdateResponse } from "./platform-updates.ts";
import { checkRouterSecret } from "./router-secret.ts";
import { rpcResponse } from "./rpc.ts";
import { screenFrameResponse, screenModuleResponse } from "./screen-frame.ts";
import {
  isRefusedToProductPage,
  setSecurityHeaders,
} from "./security-headers.ts";

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

/** The frontend's files; unknown paths get index.html (single-page app). */
const pageResponse = async (
  pathname: string,
  request: Request,
  env: Env
): Promise<Response> => {
  const page = await env.ASSETS.fetch(request);
  if (pathname !== interviewPagePath) {
    return page;
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
 * interview, with the device's key too (src/onboarding/links.ts).
 */
const linkResponse = async (
  pathname: string,
  request: Request,
  env: Env,
  requestId: string
): Promise<Response | undefined> => {
  if (pathname === guestApiPath) {
    return await guestResponse(request, env, requestId);
  }
  if (pathname === interviewApiPath) {
    return await interviewResponse(request, env, requestId);
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

/** Routes a request that has passed the router-secret check. */
const route = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname === "/health") {
    // The version answering, where there is version metadata: the console's
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
  if (pathname === connectionCallbackPath) {
    const response = await handleConnectionCallback(request, env);
    if (response !== undefined) {
      return response;
    }
  }
  if (isCatalogLogoPath(pathname)) {
    return await catalogLogoResponse(request, env, pathname, requestId);
  }
  if (pathname === auditExportPath) {
    return await auditExportResponse(request, env, requestId);
  }
  const linked = await linkResponse(pathname, request, env, requestId);
  if (linked !== undefined) {
    return linked;
  }
  if (pathname === errorReportPath) {
    return await errorReportResponse(request, env, requestId);
  }
  if (pathname === onboardingSummaryPath) {
    return await onboardingSummaryResponse(request, env, requestId);
  }
  if (pathname === platformUpdatePath) {
    return await platformUpdateResponse(request, env, requestId);
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
      const response = await route(checked.request, env, requestId);
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
