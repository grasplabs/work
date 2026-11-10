import { appErrors } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import type { OutputClass } from "@grasp-os/shared/data-policy";
import { fromBase64Url, toBase64Url } from "@grasp-os/shared/encoding";
import { authErrors } from "@grasp-os/shared/errors";
import type { CodedError } from "@grasp-os/shared/errors";
import { chatIdSchema } from "@grasp-os/shared/ids";
import type { AppId, ChatId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import {
  artifactSchema,
  pageErrors,
  pagePersonHeader,
} from "@grasp-os/shared/pages";
import type { PageDelivery } from "@grasp-os/shared/pages";
import type { Identity } from "@grasp-os/shared/rpc";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { apps, pagePolicies, sdkReleaseManifests } from "./db/core/schema.ts";
import { derivedHmacKey } from "./derived-keys.ts";
import { appHost } from "./durable-objects.ts";

// Whether a page gets its App's data: the one gate every way from an
// App to a page passes (pages-rpc.ts), and the lease that says which
// build of which version a frame runs.
//
// A page's build needs nobody's approval. It runs in a frame
// with no network of its own (`sandbox="allow-scripts"`, `connect-src
// 'none'`, page-frame.ts and security-headers.ts) and reaches nothing
// but its own App's functions, through the page and core, as the person
// viewing it, with that person's role in the App. So a page gets no
// more than its viewer may already read through the App's functions, and
// the App's functions get no more than the connections and resources an
// admin granted the App (permissions.ts). It can't send what it read
// anywhere else: WebRTC, the one way out no directive closes, is taken
// from the frame before the page runs, and the page can make no
// nested document to find it, or a network, in (page-frame.ts,
// security-headers.ts). Nor can it post it to another window: the page
// keeps no handle on a site that opened it (its opener policy), and a
// message from any window but the page or the frame itself never reaches
// a page, so another App's frame beside it hears nothing overtly (two
// colluding Apps side by side can still signal through what the tab
// shares, such as its history's length, and pass it on only through the
// second App's own grants). The one way
// out its App declares, a link to its own listed sites, opens only once
// the person confirmed it with the whole URL shown, unless an admin
// classified the App's data `ordinary` (app-link-route.ts). What a page
// puts on the clipboard (a copy behind a click) or in a drag can carry
// data the person doesn't see, but only if the person then pastes or
// drops it elsewhere themselves: accepted, as no browser offers a block
// that keeps copying usable. Every call it makes is
// the person's and recorded as such.
//
// What the gate still refuses, read on every call and every push:
//
// - A build of a release that was revoked (release-retention.ts): its
//   pages get nothing more.
// - Code core didn't serve: a call with no lease core signed. It gets the
//   App's data only once an admin classified it `ordinary`
//   (data-policy.ts), which a grant to the App takes back.
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
//   server that the page renders, a module from a string, eval. The
//   frame's document runs its build's modules and nothing else, by its
//   own policy (page-frame.ts).

/** What the lease's key is for: no other MAC of core's passes for one. */
const leasePurpose = "grasp-os page lease";

const encoder = new TextEncoder();

/**
 * One build of an App's page as core handed it out: its hash, and the
 * App's version it was opened from, whose revocation stops it
 * (`standingOf`). It says what core served and to whom, never which code
 * answers: every call of the frame's is answered by the App's current
 * release (app-functions.ts, `publicFunctionOf`), so a lease kept from
 * an older version reaches only the current code. The same hash can be a
 * page of several versions, so the version is signed with it, never
 * read from the frame.
 */
export interface LeasedBuild {
  readonly artifact: string;
  readonly version: number;
}

/**
 * What a frame runs, as core leased it: a build of the App's release,
 * whose calls the App's current release answers on the App's store; or a
 * build of a builder's draft in one of their chats, whose calls that
 * draft answers on a throwaway store with no resources (draft-runs.ts).
 * Which one is signed with the rest, so nothing a frame or a page sends
 * picks it, and no store is ever named at all: it follows from this.
 */
export type PageLease =
  | { readonly kind: "release"; readonly build: LeasedBuild }
  | {
      readonly kind: "draft";
      readonly artifact: string;
      readonly chatId: ChatId;
    };

/** What a lease signs: who was handed which build of which App, run on what. */
const leased = (principal: string, app: AppId, lease: PageLease): Uint8Array =>
  encoder.encode(
    canonicalJson(
      lease.kind === "release"
        ? [principal, app, lease.build.artifact, lease.build.version, null]
        : [principal, app, lease.artifact, null, lease.chatId]
    )
  );

/** `lease` as JSON, to key what is shared only under the same one. */
export const leaseKey = (lease: PageLease | undefined): Json => {
  if (lease === undefined) {
    return null;
  }
  return lease.kind === "release"
    ? ["release", lease.build.artifact, lease.build.version]
    : ["draft", lease.artifact, lease.chatId];
};

/** How a lease names a draft: this, then the chat's ID in base64url. */
const draftMark = "d";

/**
 * Core's word that it handed `lease` of `app` to `principal` (a member's
 * ID, or a visitor's `visitor:<session>`): the build's hash, the version
 * or the draft it runs on, and a MAC only core can make (a key derived
 * from its auth secret). The page sends it with every call (page-calls.ts)
 * and when it opens a frame (`PagesApi.frame`).
 */
export const leaseFor = async (
  env: Env,
  principal: string,
  app: AppId,
  lease: PageLease
): Promise<string> => {
  const key = await derivedHmacKey(env, leasePurpose, ["sign", "verify"]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    leased(principal, app, lease)
  );
  const [artifact, target] =
    lease.kind === "release"
      ? [lease.build.artifact, String(lease.build.version)]
      : [
          lease.artifact,
          `${draftMark}${toBase64Url(encoder.encode(lease.chatId))}`,
        ];
  return `${artifact}.${target}.${toBase64Url(new Uint8Array(mac))}`;
};

/** The longest a lease is: a hash, a version or a chat, two dots and a MAC. */
const leaseMaxLength = 256;

/**
 * Why a page's request, through its page, is refused for whom it names
 * (`pagePersonHeader`), the person its frame was opened for; undefined
 * when that is `userId`, the person signed in. Someone else is
 * `auth.principal_changed` (the browser's cookie changed hands, in another
 * tab, while the frame stayed), so what the frame sends again never runs
 * as them; nobody named is a page older than the header, out of date
 * (`page.reload_required`). A lease is signed for one person too, but
 * a call without a valid one runs where the App's data is `ordinary`, so
 * it alone doesn't hold this. Checked before a request is counted or read.
 */
export const personRefusal = (
  headers: Headers,
  userId: string
): CodedError | undefined => {
  const named = headers.get(pagePersonHeader);
  if (named === userId) {
    return undefined;
  }
  return named === null
    ? pageErrors.create("page.reload_required")
    : authErrors.create("auth.principal_changed");
};

/** A version as a lease writes it: a positive integer, in decimal. */
const leasedVersion = /^[1-9]\d{0,9}$/u;

/** The target a lease names, read back: a version, or a draft's chat. */
const targetOf = (artifact: string, target: string): PageLease | undefined => {
  if (leasedVersion.test(target)) {
    return { kind: "release", build: { artifact, version: Number(target) } };
  }
  if (!target.startsWith(draftMark)) {
    return undefined;
  }
  try {
    const chat = chatIdSchema.safeParse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        fromBase64Url(target.slice(draftMark.length))
      )
    );
    return chat.success
      ? { kind: "draft", artifact, chatId: chat.data }
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * What `lease` says core handed `principal` for `app`, or `undefined` for
 * anything core didn't sign for exactly them and that App: code core
 * didn't serve.
 */
export const readLease = async (
  env: Env,
  principal: string,
  app: AppId,
  lease: unknown
): Promise<PageLease | undefined> => {
  if (typeof lease !== "string" || lease.length > leaseMaxLength) {
    return undefined;
  }
  const [artifact, target, mac, ...more] = lease.split(".");
  if (
    artifact === undefined ||
    target === undefined ||
    mac === undefined ||
    more.length > 0 ||
    !artifactSchema.safeParse(artifact).success
  ) {
    return undefined;
  }
  const read = targetOf(artifact, target);
  if (read === undefined) {
    return undefined;
  }
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
    leased(principal, app, read)
  );
  return signed ? read : undefined;
};

/**
 * The build of the App's release `lease` says core handed `principal` for
 * `app`, or `undefined` for code core didn't serve: for what only a
 * release's page reaches (its files, its links, a visitor's calls). A
 * draft's lease is refused there (`app.preview_side_effect`), never taken
 * for none, which the App's data being `ordinary` would let through.
 */
export const leasedBuild = async (
  env: Env,
  principal: string,
  app: AppId,
  lease: unknown
): Promise<LeasedBuild | undefined> => {
  const read = await readLease(env, principal, app, lease);
  if (read?.kind === "draft") {
    throw appErrors.create("app.preview_side_effect");
  }
  return read?.build;
};

/** What core holds for one build of an App's page, read in one statement. */
export interface Standing {
  /** What the App's data is to code core didn't serve (data-policy.ts). */
  output: OutputClass;
  /** Whether core leased the caller a build: code it served. */
  served: boolean;
  /**
   * Whether the release of the App's current version, or of the version
   * the build was opened from, was revoked: its pages then get nothing
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
      (SELECT ${pagePolicies.output} FROM ${pagePolicies} WHERE ${pagePolicies.appId} = ${app}) AS output,
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
}: Standing): PageDelivery => {
  if (releaseRevoked) {
    return "revoked";
  }
  return served || output === "ordinary" ? "open" : "unreviewed";
};

/** Where a page was refused: what it asked, and at which check. */
export interface Refused {
  /** `open`, `call`, `runs`, …: the call of `PagesApi`. */
  operation: string;
  /**
   * `admission` before anything ran, `delivery` before an answer (or an
   * error) was handed over, `push` before the App's push through a
   * callback.
   */
  stage: "admission" | "delivery" | "push";
}

/**
 * Records that `by`'s page was refused its App's data. Identifiers
 * only: never what was asked for. The same refusal (who, which build,
 * why, what and where) is recorded once a window (the App's host
 * remembers when, once the row is written), so a page opened again and
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
): Promise<PageDelivery> => {
  const standing = await (read ?? standingOf(env, app, build));
  const delivery = deliveryOf(standing);
  if (delivery !== "open") {
    await recordRefusal(env, by, app, build, standing, at);
  }
  return delivery;
};

/**
 * Refuses, with `page.revoked` or `page.unreviewed`, unless `build`
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
  throw pageErrors.create(
    delivery === "revoked" ? "page.revoked" : "page.unreviewed"
  );
};

/**
 * `run`'s answer for a page running `build` of `app`: its delivery is
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
    // Refused now: the refusal goes to the page in place of the error.
    await requireDelivery(env, by, app, build, after);
    throw error;
  }
  await requireDelivery(env, by, app, build, after);
  return answer;
};
