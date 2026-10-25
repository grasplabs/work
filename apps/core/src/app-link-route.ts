import { appLinksPath, linkTargetOf } from "@grasp-os/shared/app-link-limits";
import type { LinkIntent } from "@grasp-os/shared/app-link-limits";
import {
  linkCheckSchema,
  linkErrors,
  linkOpenSchema,
} from "@grasp-os/shared/app-links";
import { versionErrors } from "@grasp-os/shared/app-releases";
import {
  authErrors,
  internalErrors,
  isExpectedError,
  requestErrors,
} from "@grasp-os/shared/errors";
import { readAtMost } from "@grasp-os/shared/http";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { screenLeaseHeader } from "@grasp-os/shared/screens";
import { drizzle } from "drizzle-orm/d1";

import { loadRelease } from "./app-releases.ts";
import { usableApp } from "./apps.ts";
import { auditedBatch, outboxed } from "./audit-outbox.ts";
import { identify } from "./auth/identity.ts";
import { appHost } from "./durable-objects.ts";
import { errorResponse } from "./errors.ts";
import { requireNotRevoked } from "./release-runner.ts";
import { isOwnOrigin } from "./rpc.ts";
import { delivering, leasedBuild, personRefusal } from "./screen-trust.ts";
import { admitted } from "./screens-rpc.ts";

// Core's link channel (spec 10.7.7, 32.3): whether a running App's screen,
// through its page, may open a URL through one of its App's
// `resource.links` declarations, and the record of each it opens. Core
// never fetches or follows the URL: the page opens it in a context of its
// own, with no opener and no referrer, and the frame hears only that it
// was opened. `<appLinksPath>/<app>/<alias>/…`:
//
// - `POST check` whether the URL may open, before the page asks the person
// - `POST open`  the same, recorded as opened, with how the person asked
//
// Which URL may open is decided by `linkTargetOf` (app-link-limits.ts,
// with its own threat model: userinfo, Unicode names, ports, trailing
// dots, schemes, private networks, redirects). This route decides who is
// asking and through what. Threat model, and how each is closed:
//
// - Another site, or a page of the deployment's that isn't a screen's,
//   asks: every request needs the frame's lease in a header, verified for
//   the person and App, a `Sec-Fetch-Site` of the same origin when sent,
//   and the deployment's own `Origin`.
// - The frame was opened for one person and the cookie is now someone
//   else's: a request naming anyone else is refused before it is counted
//   or read (`personRefusal`).
// - Someone without a role in the App, a version whose release was
//   revoked, a build nobody approved, an App archived (nobody uses one):
//   the session, the role and the App's status (`usableApp`),
//   the current version's release and its revocation are read on every
//   request, inside `delivering`, which checks the lease's build is still
//   trusted before and after. A check and its open each decide anew, so a
//   revocation while the person reads the confirmation opens nothing.
// - A screen opens what its App didn't declare: the origins are the
//   current release's `resource.links` declaration's, never what the
//   request says; a resource of another kind, or none, opens nothing.
// - An App that read restricted data sends it out in a URL: such an App's
//   links open only once the person confirmed each in the page's dialog
//   (`confirm` in a check's answer); an open claiming a click is refused
//   (`link.confirmation_required`).
// - A flood: each request counts against the person's requests of the
//   App's screens (`admitted`) before anything else is read.
// - The record holds what it shouldn't: each open is audited with its
//   origin, resource, version and how it was asked, never its path or
//   query, which may carry personal data.

/** A link channel request, as its path names it. */
export interface LinkRoute {
  readonly app: string;
  readonly resource: string;
  readonly kind: "check" | "open";
}

const segment = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * The link channel request `pathname` names: undefined for a path outside
 * the channel, `"not_found"` for one inside it that names no request.
 */
export const linkRouteOf = (
  pathname: string,
  method: string
): LinkRoute | "not_found" | undefined => {
  const prefix = `${appLinksPath}/`;
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const [app = "", resource = "", kind, ...more] = pathname
    .slice(prefix.length)
    .split("/");
  return method === "POST" &&
    more.length === 0 &&
    (kind === "check" || kind === "open") &&
    segment.test(app) &&
    segment.test(resource)
    ? { app, resource, kind }
    : "not_found";
};

/** The HTTP status of each refusal that isn't a plain 403. */
const statuses: Readonly<Record<string, number>> = {
  "screen.rate_limited": 429,
  "auth.unauthenticated": 401,
  "auth.principal_changed": 401,
  "app.not_found": 404,
  "link.invalid": 422,
  "request.too_large": 413,
};

/** The status a refusal answers with. */
const statusOf = (code: string): number =>
  Object.hasOwn(statuses, code) ? (statuses[code] ?? 403) : 403;

/** Whether a request may come from where it did (see the header). */
const fromOwnPage = (request: Request, env: Env): boolean => {
  if (request.headers.get(screenLeaseHeader) === null) {
    return false;
  }
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") {
    return false;
  }
  return isOwnOrigin(request, env);
};

/** The longest body the channel reads: a URL at its bound, as JSON. */
const jsonMaxBytes = 8192;

/** A request's body, as the byte stream workerd gives it. */
const bodyOf = (request: Request): ReadableStream<Uint8Array> | null =>
  request.body;

/** A JSON request body, read no further than `jsonMaxBytes`. */
const jsonBody = async (request: Request): Promise<unknown> => {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  ) {
    throw linkErrors.create("link.invalid");
  }
  const stream = bodyOf(request);
  const bytes =
    stream === null ? undefined : await readAtMost(stream, jsonMaxBytes);
  if (bytes === undefined) {
    throw requestErrors.create("request.too_large");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw linkErrors.create("link.invalid");
  }
};

/** What the page asked, read as what it is for its request. */
const askedOf = async (
  request: Request,
  kind: LinkRoute["kind"]
): Promise<{ url: string; intent: LinkIntent | undefined }> => {
  const body = await jsonBody(request);
  if (kind === "check") {
    const parsed = linkCheckSchema.safeParse(body);
    if (!parsed.success) {
      throw linkErrors.create("link.invalid");
    }
    return { url: parsed.data.url, intent: undefined };
  }
  const parsed = linkOpenSchema.safeParse(body);
  if (!parsed.success) {
    throw linkErrors.create("link.invalid");
  }
  return parsed.data;
};

/** What an App's link resource lets open, as its current release says. */
interface Decided {
  readonly url: string;
  readonly origin: string;
  readonly version: number;
  /** Whether the App read restricted data: each open needs the dialog. */
  readonly confirm: boolean;
}

/**
 * Whether `person` may open `url` through App `app`'s links resource
 * `resource` now, as its current release declares it (see the header).
 */
const decided = async (
  env: Env,
  person: Identity,
  app: AppId,
  resource: string,
  url: string
): Promise<Decided> => {
  const found = await usableApp(env, person, app, "user");
  if (found.currentVersion === null) {
    throw versionErrors.create("version.not_sealed");
  }
  const release = await loadRelease(env, found.id, found.currentVersion);
  await requireNotRevoked(env, found.id, found.currentVersion);
  const declared = Object.hasOwn(release.app.browserResources, resource)
    ? release.app.browserResources[resource]
    : undefined;
  if (declared?.["~resource"] !== "links") {
    throw linkErrors.create("link.not_allowed");
  }
  const target = linkTargetOf(url, declared.origins);
  if (!target.ok) {
    throw linkErrors.create(
      target.reason === "invalid" ? "link.invalid" : "link.not_allowed"
    );
  }
  return {
    url: target.url,
    origin: target.origin,
    version: found.currentVersion,
    confirm: await appHost(env, app).isRestricted(),
  };
};

/** Records that `person` opened `opened` through `resource`, as `intent`. */
const auditOpen = async (
  env: Env,
  person: Identity,
  app: AppId,
  resource: string,
  opened: Decided,
  intent: LinkIntent
): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxed(db, {
      actor: { type: "person", userId: person.userId },
      action: "app.link_opened",
      target: { type: "app", id: app },
      detail: {
        resource,
        origin: opened.origin,
        version: opened.version,
        intent,
        restricted: opened.confirm,
      },
    }),
  ]);
};

/**
 * A request of core's link channel (see the header), for the person
 * signed in, as their screen running the build its lease names. Answers
 * the URL to open, its origin and whether the person must confirm it.
 */
export const appLinkResponse = async (
  request: Request,
  env: Env,
  route: LinkRoute,
  requestId: string
): Promise<Response> => {
  if (!fromOwnPage(request, env)) {
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }
  const person = await identify(env, request.headers);
  if (person === undefined) {
    return errorResponse(
      401,
      authErrors.create("auth.unauthenticated"),
      requestId
    );
  }
  const refusal = personRefusal(request.headers, person.userId);
  if (refusal !== undefined) {
    log.info("app_link.person_refused", { requestId, reason: refusal.code });
    return errorResponse(statusOf(refusal.code), refusal, requestId);
  }
  try {
    const app = await admitted(env, person, route.app);
    const build = await leasedBuild(
      env,
      person.userId,
      app,
      request.headers.get(screenLeaseHeader)
    );
    // A lease that doesn't verify, for this person and App, is no screen
    // of theirs: nothing else opens links through the channel.
    if (build === undefined) {
      throw requestErrors.create("request.forbidden");
    }
    const { url, intent } = await askedOf(request, route.kind);
    const answer = await delivering(
      env,
      person,
      app,
      build,
      "link",
      async () => {
        const allowed = await decided(env, person, app, route.resource, url);
        if (intent !== undefined) {
          if (allowed.confirm && intent === "activation") {
            throw linkErrors.create("link.confirmation_required");
          }
          await auditOpen(env, person, app, route.resource, allowed, intent);
        }
        return allowed;
      }
    );
    return Response.json(
      { url: answer.url, origin: answer.origin, confirm: answer.confirm },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (isExpectedError(error)) {
      return errorResponse(statusOf(error.code), error, requestId);
    }
    log.error("app_link.failed", { requestId, ...errorFields(error) });
    return errorResponse(
      500,
      internalErrors.create("internal.unexpected"),
      requestId
    );
  }
};
