import { actorOf } from "@grasp-os/shared/audit";
import { sha256HexOfBytes } from "@grasp-os/shared/encoding";
import { authErrors, requestErrors } from "@grasp-os/shared/errors";
import { log } from "@grasp-os/shared/log";
import {
  organizationErrors,
  organizationLogoMaxBytes,
  organizationLogoMaxPixels,
  organizationLogoPrefix,
} from "@grasp-os/shared/organization";
import type { OrganizationLogoType } from "@grasp-os/shared/organization";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { activeMember, organizationId } from "./auth/auth.ts";
import { identify } from "./auth/identity.ts";
import { organizations } from "./db/core/schema.ts";
import { errorResponse } from "./errors.ts";
import { imageHeaderOf } from "./files/image-header.ts";
import type { ImageHeader } from "./files/image-header.ts";
import { requireOwnAdmin, stillAdmin } from "./organization-admin.ts";
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
//   PNG, JPEG and WebP are taken, told by their headers; the call takes
//   bytes alone, so there is no name or declared type to trust. SVG
//   never. A polyglot (a PNG's header with HTML after it) is still served
//   only as the image type core found, with `nosniff`, and opened on its
//   own it gets a policy that runs and loads nothing (security-headers.ts).
// - A file large enough to hurt: refused past 512 KB before it is kept.
//   So is an image whose header declares more than 4096 pixels a side,
//   which every member's browser would decode on every page.
// - Someone outside the organization reading it: the route serves only
//   signed-in members of this deployment's organization (`routeMember`;
//   a guest is nobody to `identify`), and only the logo it has now, by its
//   content's hash. Members only is intended: the logo is the company's
//   branding inside Grasp, and the sign-in page shows none.
// - One change recorded as many, or not at all: one audit event per set
//   or removal, in the same batch as the change, and none when nothing
//   changed.
// - A logo kept after it is replaced or removed: the object goes from the
//   bucket once the organization no longer names it, and an upload whose
//   write failed goes too, unless the database can't be read either: then
//   it stays, unseen, and the caller hears the write's own error. Each
//   delete first reads which logo is named, and keeps that one. Two admins
//   changing the logo at the very same moment can still leave an object
//   behind, unseen; and a change that lands between that read and the
//   delete just after it can still take away the logo it names: its route
//   then answers 404 until the logo is set again.
// Stored in the files bucket (EU, as every bucket of core's), under the
// image's own SHA-256, so the address changes with the image and a
// browser may keep each one for good.

/** Where a logo is kept in the files bucket. */
const keyOf = (hash: string): string => `organization/logo/${hash}`;

/** What a logo's header says it is: a PNG, JPEG or WebP, never a GIF. */
const logoHeaderOf = (
  bytes: Uint8Array
): (ImageHeader & { type: OrganizationLogoType }) | undefined => {
  const header = imageHeaderOf(bytes);
  return header === undefined || header.type === "image/gif"
    ? undefined
    : { ...header, type: header.type };
};

/** The logo the organization has now: its hash, or none. */
const currentHash = async (env: Env): Promise<string | null> => {
  const [row] = await drizzle(env.DB)
    .select({ logo: organizations.logo })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row?.logo ?? null;
};

/**
 * Lets go of the logo `hash`, unless the organization names it (again).
 * It never fails: should the database or the bucket fail, the object is
 * only left behind.
 */
const forget = async (env: Env, hash: string | null): Promise<void> => {
  if (hash === null) {
    return;
  }
  try {
    if ((await currentHash(env)) !== hash) {
      await env.FILES.delete(keyOf(hash));
    }
  } catch (error) {
    log.warn("organization.logo_forget_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/** `image`, checked: a PNG, JPEG or WebP within the limits, and its type. */
const checkedLogo = (
  image: unknown
): { bytes: Uint8Array; type: OrganizationLogoType } => {
  if (!(image instanceof Uint8Array)) {
    throw organizationErrors.create("organization.logo_invalid");
  }
  if (image.byteLength > organizationLogoMaxBytes) {
    throw organizationErrors.create("organization.logo_too_large");
  }
  const header = logoHeaderOf(image);
  if (header === undefined || header.width < 1 || header.height < 1) {
    throw organizationErrors.create("organization.logo_invalid");
  }
  if (
    header.width > organizationLogoMaxPixels ||
    header.height > organizationLogoMaxPixels
  ) {
    throw organizationErrors.create("organization.logo_too_wide");
  }
  return { bytes: image, type: header.type };
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
  const { bytes, type } = checkedLogo(image);
  const hash = await sha256HexOfBytes(bytes);
  const before = await currentHash(env);
  await env.FILES.put(keyOf(hash), bytes, {
    httpMetadata: { contentType: type },
  });
  const db = drizzle(env.DB);
  let changed: { id: string }[];
  try {
    [changed] = await auditedBatch(env, db, [
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
        detail: { type, bytes: bytes.byteLength },
      }),
    ]);
  } catch (error) {
    // The upload goes, unless the database can't be read now either; the
    // caller hears the write's own error.
    await forget(env, hash);
    throw error;
  }
  if (changed.length > 0) {
    await forget(env, before);
    return;
  }
  // Nothing changed: it was this logo already, or they stopped being an
  // admin since their session was checked.
  if (!(await stillAdmin(env, by.userId))) {
    await forget(env, hash);
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
