import { actorOf } from "@grasp-os/shared/audit";
import { authErrors, requestErrors } from "@grasp-os/shared/errors";
import { log } from "@grasp-os/shared/log";
import {
  organizationErrors,
  organizationLogoMaxBytes,
  organizationLogoPath,
  organizationLogoPrefix,
} from "@grasp-os/shared/organization";
import type { OrganizationLogoType } from "@grasp-os/shared/organization";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { activeMember, organizationId } from "./auth/auth.ts";
import { identify } from "./auth/identity.ts";
import { organizations } from "./db/core/schema.ts";
import { errorResponse } from "./errors.ts";
import { routeMember } from "./staff-audit.ts";

// The organization's logo (Settings › Workspace), shown in its sidebar.
//
// How it can go wrong, and what stops it:
// - Someone other than the organization's own admins sets or removes it:
//   a builder, a user, a guest, Grasp staff (whose session never reaches
//   the workspace: session-check.ts), or an admin demoted while their
//   session is open. The call refuses anyone but an admin who isn't staff,
//   and the write itself holds only while they still are one
//   (`activeMember`).
// - A file a browser would run: an SVG with script, HTML named .png. Only
//   PNG, JPEG and WebP are taken, told by their first bytes; the call
//   takes bytes alone, so there is no name or declared type to trust. SVG
//   never. A polyglot (a PNG signature with HTML after it) is still served
//   only as the image type core found, with `nosniff`, and opened on its
//   own it gets a policy that runs and loads nothing (security-headers.ts).
// - A file large enough to hurt: refused past 512 KB before it is kept.
// - Someone outside the organization reading it: the route serves only
//   signed-in members of this deployment's organization (`routeMember`;
//   a guest is nobody to `identify`), and only the logo it has now, by its
//   content's hash. Members only is intended: the logo is the company's
//   branding inside Grasp, and the sign-in page shows none.
// - One change recorded as many, or not at all: one audit event per set
//   or removal, in the same batch as the change, and none when nothing
//   changed.
// - A logo kept after it is replaced or removed: the object goes from the
//   bucket once the organization no longer names it. Two admins changing
//   it at the very same moment may leave one behind, unseen, or (should
//   one set the logo it had while another replaces it) take away the one
//   named, and the initials stand in until it is set again.
// Stored in the files bucket (EU, as every bucket of core's), under the
// image's own SHA-256, so the address changes with the image and a
// browser may keep each one for good.

/** Where a logo is kept in the files bucket. */
const keyOf = (hash: string): string => `organization/logo/${hash}`;

/** A logo's hash, as the organization keeps it. */
const hashPattern = /^[\da-f]{64}$/u;

/** Whether `bytes` start with `prefix`, from `at`. */
const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  prefix.every((byte, index) => bytes[at + index] === byte);

/** The image type `bytes` are, by their first bytes; none for anything else. */
const logoTypeOf = (bytes: Uint8Array): OrganizationLogoType | undefined => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  // "RIFF", four bytes of size, "WEBP".
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  return undefined;
};

/** The hash the organization keeps, if it is one; null for anything else. */
const hashOf = (stored: string | null): string | null =>
  stored !== null && hashPattern.test(stored) ? stored : null;

/** The logo's address, from what the organization keeps; null for none. */
export const logoPathOf = (stored: string | null): string | null => {
  const hash = hashOf(stored);
  return hash === null ? null : organizationLogoPath(hash);
};

/** Refuses anyone but the organization's own admins. */
const requireOwnAdmin = (by: Identity): void => {
  if (by.staff || !isAdmin(by.role)) {
    log.warn("organization.refused", { actor: by.userId });
    throw roleErrors.create("role.forbidden");
  }
};

/** Whether `userId` is an admin of the organization now. */
const stillAdmin = async (env: Env, userId: string): Promise<boolean> => {
  const row = await drizzle(env.DB).get<{ admin: number }>(
    sql`SELECT ${activeMember(userId, ["admin"])} AS admin`
  );
  return row.admin === 1;
};

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** The logo the organization has now: its hash, or none. */
const currentHash = async (env: Env): Promise<string | null> => {
  const [row] = await drizzle(env.DB)
    .select({ logo: organizations.logo })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return hashOf(row?.logo ?? null);
};

/** Lets go of a logo no longer named; a failure only leaves it behind. */
const forget = async (env: Env, hash: string | null): Promise<void> => {
  if (hash === null) {
    return;
  }
  try {
    await env.FILES.delete(keyOf(hash));
  } catch (error) {
    log.warn("organization.logo_forget_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Sets the organization's logo from `image`, as `by`, an admin of its
 * own: kept in the files bucket, then named on the organization with its
 * audit event in one batch. The logo it replaces is let go of.
 */
export const setOrganizationLogo = async (
  env: Env,
  by: Identity,
  image: unknown
): Promise<void> => {
  requireOwnAdmin(by);
  if (!(image instanceof Uint8Array)) {
    throw organizationErrors.create("organization.logo_invalid");
  }
  if (image.byteLength > organizationLogoMaxBytes) {
    throw organizationErrors.create("organization.logo_too_large");
  }
  const type = logoTypeOf(image);
  if (type === undefined) {
    throw organizationErrors.create("organization.logo_invalid");
  }
  const hash = hex(await crypto.subtle.digest("SHA-256", image));
  const before = await currentHash(env);
  await env.FILES.put(keyOf(hash), image, {
    httpMetadata: { contentType: type },
  });
  const db = drizzle(env.DB);
  const [changed] = await auditedBatch(env, db, [
    db
      .update(organizations)
      .set({ logo: hash })
      .where(
        and(
          eq(organizations.id, organizationId),
          or(isNull(organizations.logo), ne(organizations.logo, hash)),
          activeMember(by.userId, ["admin"])
        )
      )
      .returning({ id: organizations.id }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "organization.logo.updated",
      target: { type: "organization", id: organizationId },
      detail: { type, bytes: image.byteLength },
    }),
  ]);
  if (changed.length > 0) {
    if (before !== hash) {
      await forget(env, before);
    }
    return;
  }
  // Nothing changed: it was this logo already, or they stopped being an
  // admin since their session was checked.
  if (!(await stillAdmin(env, by.userId))) {
    if ((await currentHash(env)) !== hash) {
      await forget(env, hash);
    }
    throw roleErrors.create("role.forbidden");
  }
};

/** Takes the organization's logo away, as `by`, an admin of its own. */
export const removeOrganizationLogo = async (
  env: Env,
  by: Identity
): Promise<void> => {
  requireOwnAdmin(by);
  const before = await currentHash(env);
  const db = drizzle(env.DB);
  const [changed] = await auditedBatch(env, db, [
    db
      .update(organizations)
      .set({ logo: null })
      .where(
        and(
          eq(organizations.id, organizationId),
          isNotNull(organizations.logo),
          activeMember(by.userId, ["admin"])
        )
      )
      .returning({ id: organizations.id }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "organization.logo.removed",
      target: { type: "organization", id: organizationId },
    }),
  ]);
  if (changed.length > 0) {
    await forget(env, before);
    return;
  }
  // Nothing changed: it had none, or they stopped being an admin since
  // their session was checked.
  if (!(await stillAdmin(env, by.userId))) {
    throw roleErrors.create("role.forbidden");
  }
};

/** `/api/organization/logo/<hash>`: the organization's logo. */
const logoPathPattern = new RegExp(
  `^${organizationLogoPrefix}(?<hash>[\\da-f]{64})$`,
  "u"
);

/**
 * The organization's logo, to a signed-in member of it: only the one it
 * has now, as the image type core found, kept by the browser for good
 * (the address changes with the image). Anyone else is told to sign in;
 * any other hash is not found. Undefined for any other path.
 */
export const logoResponse = async (
  pathname: string,
  request: Request,
  env: Env,
  requestId: string
): Promise<Response | undefined> => {
  const hash = logoPathPattern.exec(pathname)?.groups?.hash;
  if (hash === undefined) {
    return undefined;
  }
  const notFound = () =>
    errorResponse(404, requestErrors.create("request.not_found"), requestId);
  if (request.method !== "GET") {
    return notFound();
  }
  const person = await routeMember(
    env,
    await identify(env, request.headers),
    "organization.logo",
    { hash }
  );
  if (person === undefined) {
    return errorResponse(
      401,
      authErrors.create("auth.unauthenticated"),
      requestId
    );
  }
  if ((await currentHash(env)) !== hash) {
    return notFound();
  }
  const kept = await env.FILES.get(keyOf(hash));
  const type = kept?.httpMetadata?.contentType;
  if (kept === null || type === undefined) {
    return notFound();
  }
  // `nosniff` and a policy that runs nothing come with every answer on
  // this path (security-headers.ts).
  return new Response(kept.body, {
    headers: {
      "content-type": type,
      "content-length": String(kept.size),
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
};
