import { actorOf } from "@grasp-os/shared/audit";
import type { OutputClass } from "@grasp-os/shared/data-policy";
import { fromBase64Url, toBase64Url } from "@grasp-os/shared/encoding";
import { authErrors } from "@grasp-os/shared/errors";
import type { CodedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  artifactSchema,
  screenErrors,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import type { ScreenDelivery } from "@grasp-os/shared/screens";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { apps, screenPolicies, sdkReleaseManifests } from "./db/core/schema.ts";
import { derivedHmacKey } from "./derived-keys.ts";
import { appHost } from "./durable-objects.ts";

// Whether a screen gets its App's data: the one gate every way from an
// App to a screen passes (screens-rpc.ts), and the lease that says which
// build of which version a frame runs.
//
// A screen's build needs nobody's approval. It runs in a frame
// with no network of its own (`sandbox="allow-scripts"`, `connect-src
// 'none'`, screen-frame.ts and security-headers.ts) and reaches nothing
// but its own App's functions, through the page and core, as the person
// viewing it, with that person's role in the App. So a screen gets no
// more than its viewer may already read through the App's functions, and
// the App's functions get no more than the connections and resources an
// admin granted the App (permissions.ts). It can't send what it read
// anywhere else: WebRTC, the one way out no directive closes, is taken
// from the frame before the screen runs, and the screen can make no
// nested document to find it, or a network, in (screen-frame.ts,
// security-headers.ts). Nor can it post it to another window: the page
// keeps no handle on a site that opened it (its opener policy), and a
// message from any window but the page never reaches a screen, so
// another App's frame beside it hears nothing. Every call it makes is
// the person's and recorded as such.
//
// What the gate still refuses, read on every call and every push:
//
// - A build of a release that was revoked (release-retention.ts): its
//   screens get nothing more.
// - Code core didn't serve: a call with no lease core signed, which is
//   what a portable host (spec 10.7.1) makes, with an App token, from code
//   with all the network its browser or app gives it. It gets the App's
//   data only once an admin classified it `ordinary` (data-policy.ts),
//   which a grant to the App takes back.
//
// What could go wrong, and what stops it:
//
// - A lease naming another version or App, or used by someone else. It is
//   signed over the person, the App, the build and the version, only core
//   can sign it (`leaseFor`), and it is checked against the session. A
//   call with no valid lease is code core didn't serve (above).
// - A revocation while a call runs. The release's revocation is read
//   before the App is called and again before its answer or its error is
//   handed over (an error carries the App's own message), and before every
//   push: a revocation that committed stops the next of them.
// - Code other than the build running in the frame: HTML from the App's
//   server that the screen renders, a module from a string, eval. The
//   frame's document runs its build's modules and nothing else, by its
//   own policy (screen-frame.ts).

/** What the lease's key is for: no other MAC of core's passes for one. */
const leasePurpose = "grasp-os screen lease";

const encoder = new TextEncoder();

/**
 * One build of an App's screen as core handed it out: its hash, and the
 * App's version it was opened from, whose release the frame's calls are
 * pinned to (app-functions.ts, `pinnedReference`) and whose revocation
 * stops it (`standingOf`). The same hash can be a screen of several
 * versions, so the version is signed with it, never read from the frame.
 */
export interface LeasedBuild {
  readonly artifact: string;
  readonly version: number;
}

/** What a lease signs: who was handed which build of which App. */
const leased = (
  userId: string,
  app: AppId,
  { artifact, version }: LeasedBuild
): Uint8Array =>
  encoder.encode(canonicalJson([userId, app, artifact, version]));

/**
 * Core's word that it handed `build` of `app` to `userId`: the build's
 * hash, the version it was opened from and a MAC only core can make (a
 * key derived from its auth secret). The page gives it back when it opens
 * the frame (`ScreensApi.frame`); it says which build of which version.
 */
export const leaseFor = async (
  env: Env,
  userId: string,
  app: AppId,
  build: LeasedBuild
): Promise<string> => {
  const key = await derivedHmacKey(env, leasePurpose, ["sign", "verify"]);
  const mac = await crypto.subtle.sign("HMAC", key, leased(userId, app, build));
  return `${build.artifact}.${build.version}.${toBase64Url(new Uint8Array(mac))}`;
};

/** The longest a lease is: a hash, a version, two dots and a MAC. */
const leaseMaxLength = 144;

/**
 * Why a screen's request, through its page, is refused for whom it names
 * (`screenPersonHeader`), the person its frame was opened for; undefined
 * when that is `userId`, the person signed in. Someone else is
 * `auth.principal_changed` (the browser's cookie changed hands, in another
 * tab, while the frame stayed), so what the frame sends again never runs
 * as them; nobody named is a page older than the header, out of date
 * (`screen.reload_required`). A lease is signed for one person too, but
 * a call without a valid one runs where the App's data is `ordinary`, so
 * it alone doesn't hold this. Checked before a request is counted or read.
 */
export const personRefusal = (
  headers: Headers,
  userId: string
): CodedError | undefined => {
  const named = headers.get(screenPersonHeader);
  if (named === userId) {
    return undefined;
  }
  return named === null
    ? screenErrors.create("screen.reload_required")
    : authErrors.create("auth.principal_changed");
};

/** A version as a lease writes it: a positive integer, in decimal. */
const leasedVersion = /^[1-9]\d{0,9}$/u;

/**
 * The build `lease` says core handed `userId` for `app`, or `undefined`
 * for anything core didn't sign for exactly them and that App.
 */
export const leasedBuild = async (
  env: Env,
  userId: string,
  app: AppId,
  lease: unknown
): Promise<LeasedBuild | undefined> => {
  if (typeof lease !== "string" || lease.length > leaseMaxLength) {
    return undefined;
  }
  const [artifact, version, mac, ...more] = lease.split(".");
  if (
    mac === undefined ||
    more.length > 0 ||
    version === undefined ||
    !leasedVersion.test(version) ||
    !artifactSchema.safeParse(artifact).success ||
    artifact === undefined
  ) {
    return undefined;
  }
  const build: LeasedBuild = { artifact, version: Number(version) };
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = fromBase64Url(mac);
  } catch {
    return undefined;
  }
  const key = await derivedHmacKey(env, leasePurpose, ["sign", "verify"]);
  const signed = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    leased(userId, app, build)
  );
  return signed ? build : undefined;
};

/** What core holds for one build of an App's screen, read in one statement. */
export interface Standing {
  /** What the App's data is to code core didn't serve (data-policy.ts). */
  output: OutputClass;
  /** Whether core leased the caller a build: code it served. */
  served: boolean;
  /**
   * Whether the release of the App's current version, or of the version
   * the build was opened from, was revoked: its screens then get nothing
   * more.
   */
  releaseRevoked: boolean;
}

/**
 * What core holds now for `build` of `app`; with no build (code core
 * didn't serve), only the current version's release counts.
 */
export const standingOf = async (
  env: Env,
  app: AppId,
  build?: LeasedBuild
): Promise<Standing> => {
  const row = await drizzle(env.DB).get<{
    output: OutputClass | null;
    releaseRevoked: number;
  }>(
    sql`SELECT
      (SELECT ${screenPolicies.output} FROM ${screenPolicies} WHERE ${screenPolicies.appId} = ${app}) AS output,
      EXISTS (SELECT 1 FROM ${sdkReleaseManifests}
        WHERE ${sdkReleaseManifests.appId} = ${app}
          AND (${sdkReleaseManifests.version} =
            (SELECT ${apps.currentVersion} FROM ${apps} WHERE ${apps.id} = ${app})
            OR ${sdkReleaseManifests.version} = ${build?.version ?? null})
          AND ${sdkReleaseManifests.revokedAt} IS NOT NULL) AS releaseRevoked`
  );
  return {
    output: row.output ?? "sensitive",
    served: build !== undefined,
    releaseRevoked: row.releaseRevoked === 1,
  };
};

/**
 * Whether code with that standing gets its App's data: never once the
 * release it runs, or the App's current one, was revoked; otherwise
 * always when core served it, and when it didn't, only once an admin
 * classified the App's data `ordinary`.
 */
export const deliveryOf = ({
  output,
  served,
  releaseRevoked,
}: Standing): ScreenDelivery => {
  if (releaseRevoked) {
    return "revoked";
  }
  return served || output === "ordinary" ? "open" : "unreviewed";
};

/** Where a screen was refused: what it asked, and at which check. */
export interface Refused {
  /** `open`, `call`, `runs`, …: the call of `ScreensApi`. */
  operation: string;
  /**
   * `admission` before anything ran, `delivery` before an answer (or an
   * error) was handed over, `push` before the App's push through a
   * callback.
   */
  stage: "admission" | "delivery" | "push";
}

/**
 * Records that `by`'s screen was refused its App's data. Identifiers
 * only: never what was asked for. The same refusal (who, which build,
 * why, what and where) is recorded once a window (the App's host
 * remembers when, once the row is written), so a screen opened again and
 * again, or a page that keeps retrying, adds no row per try.
 */
const recordRefusal = async (
  env: Env,
  by: Pick<Identity, "userId" | "staff">,
  app: AppId,
  build: LeasedBuild | undefined,
  standing: Standing,
  { operation, stage }: Refused
): Promise<void> => {
  const reason = deliveryOf(standing);
  const refusal = canonicalJson([
    by.userId,
    build?.artifact ?? null,
    build?.version ?? null,
    reason,
    operation,
    stage,
  ]);
  await appHost(env, app).auditOnce(refusal, {
    actor: actorOf(by),
    action: "app.artifact.refused",
    target: { type: "app", id: app },
    detail: {
      artifact: build?.artifact ?? null,
      version: build?.version ?? null,
      reason,
      operation,
      stage,
    },
  });
};

/**
 * Whether `build` of `app` gets the App's data now, for a push, and if
 * not, why (`revoked` or `unreviewed`): a refusal is recorded. `read` is
 * what core holds now (`standingOf`), when its caller shares one read
 * among several checks of the same build.
 */
export const deliveryAt = async (
  env: Env,
  by: Pick<Identity, "userId" | "staff">,
  app: AppId,
  build: LeasedBuild | undefined,
  at: Refused,
  read?: Promise<Standing>
): Promise<ScreenDelivery> => {
  const standing = await (read ?? standingOf(env, app, build));
  const delivery = deliveryOf(standing);
  if (delivery !== "open") {
    await recordRefusal(env, by, app, build, standing, at);
  }
  return delivery;
};

/**
 * Whether `build` of `app` gets the App's data now, for a push: a
 * refusal is recorded, and answers false.
 */
export const deliveryOpen = async (
  env: Env,
  by: Pick<Identity, "userId" | "staff">,
  app: AppId,
  build: LeasedBuild | undefined,
  at: Refused
): Promise<boolean> => (await deliveryAt(env, by, app, build, at)) === "open";

/**
 * Refuses, with `screen.revoked` or `screen.unreviewed`, unless `build`
 * of `app` gets the App's data now. The refusal is recorded first.
 */
export const requireDelivery = async (
  env: Env,
  by: Pick<Identity, "userId" | "staff">,
  app: AppId,
  build: LeasedBuild | undefined,
  at: Refused
): Promise<void> => {
  const standing = await standingOf(env, app, build);
  const delivery = deliveryOf(standing);
  if (delivery === "open") {
    return;
  }
  await recordRefusal(env, by, app, build, standing, at);
  throw screenErrors.create(
    delivery === "revoked" ? "screen.revoked" : "screen.unreviewed"
  );
};

/**
 * `run`'s answer for a screen running `build` of `app`: its delivery is
 * read before `run`, so code refused starts nothing, and again before
 * whatever `run` ends with is handed over, its answer or its error, so a
 * release revoked, or data made `sensitive` again, while it ran keeps
 * both here. An error counts: the
 * App's own message travels in it (`app.failed`), and can hold what it
 * read. What `run` already changed stays changed.
 */
export const delivering = async <Answer>(
  env: Env,
  by: Pick<Identity, "userId" | "staff">,
  app: AppId,
  build: LeasedBuild | undefined,
  operation: string,
  run: () => Promise<Answer>
): Promise<Answer> => {
  const before: Refused = { operation, stage: "admission" };
  const after: Refused = { operation, stage: "delivery" };
  await requireDelivery(env, by, app, build, before);
  let answer: Answer;
  try {
    answer = await run();
  } catch (error) {
    // Refused now: the refusal goes to the screen in place of the error.
    await requireDelivery(env, by, app, build, after);
    throw error;
  }
  await requireDelivery(env, by, app, build, after);
  return answer;
};
