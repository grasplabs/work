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

/** What a logo's header says it is. */
interface LogoHeader {
  type: OrganizationLogoType;
  width: number;
  height: number;
}

/** Whether `bytes` hold `prefix` at `at`. */
const holds = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  bytes.length >= at + prefix.length &&
  prefix.every((byte, index) => bytes[at + index] === byte);

const ascii = (text: string): number[] => [...new TextEncoder().encode(text)];

/** The low 14 bits of `value`, where WebP keeps a size. */
const low14 = (value: number): number => value % 0x40_00;

/** `bytes` as a view to read numbers from. */
const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** A 24-bit little-endian number at `at`. */
const u24le = (view: DataView, at: number): number =>
  view.getUint16(at, true) + view.getUint8(at + 2) * 0x1_00_00;

/**
 * A PNG's size, from its IHDR chunk, which the specification puts first,
 * right after the signature (PNG §5.6, §11.2.2): width, then height, each
 * a four-byte big-endian number.
 */
const pngHeader = (bytes: Uint8Array): LogoHeader | undefined => {
  if (
    !(
      holds(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) &&
      holds(bytes, [0, 0, 0, 13, ...ascii("IHDR")], 8) &&
      bytes.length >= 24
    )
  ) {
    return undefined;
  }
  const view = viewOf(bytes);
  return {
    type: "image/png",
    width: view.getUint32(16),
    height: view.getUint32(20),
  };
};

/**
 * A WebP's size (RFC 9649): "RIFF", its size, "WEBP", then its first
 * chunk, its FourCC and size, all within the RIFF size, and that within
 * the file. A simple lossy file's "VP8 " chunk starts with a key frame
 * (RFC 6386 §9.1: its frame tag's lowest bit clear, then the start code)
 * holding 14-bit sizes; a lossless one's "VP8L" holds each size less one
 * in 14 bits after its signature byte; an extended one's "VP8X" holds the
 * canvas's sizes less one in 24 bits.
 */
const webpHeader = (bytes: Uint8Array): LogoHeader | undefined => {
  if (
    !(
      holds(bytes, ascii("RIFF")) &&
      holds(bytes, ascii("WEBP"), 8) &&
      bytes.length >= 30
    )
  ) {
    return undefined;
  }
  const view = viewOf(bytes);
  const riffEnd = 8 + view.getUint32(4, true);
  const chunkEnd = 20 + view.getUint32(16, true);
  if (riffEnd > bytes.length || chunkEnd > riffEnd) {
    return undefined;
  }
  // Each header must lie within its chunk: VP8's sizes end at byte 30,
  // VP8L's at 25, and VP8X's chunk is ten bytes long.
  if (
    holds(bytes, ascii("VP8 "), 12) &&
    chunkEnd >= 30 &&
    view.getUint8(20) % 2 === 0 &&
    holds(bytes, [0x9d, 0x01, 0x2a], 23)
  ) {
    return {
      type: "image/webp",
      width: low14(view.getUint16(26, true)),
      height: low14(view.getUint16(28, true)),
    };
  }
  if (
    holds(bytes, ascii("VP8L"), 12) &&
    chunkEnd >= 25 &&
    holds(bytes, [0x2f], 20)
  ) {
    const sizes = view.getUint32(21, true);
    return {
      type: "image/webp",
      width: low14(sizes) + 1,
      height: low14(Math.floor(sizes / 0x40_00)) + 1,
    };
  }
  if (holds(bytes, ascii("VP8X"), 12) && chunkEnd === 30) {
    return {
      type: "image/webp",
      width: u24le(view, 24) + 1,
      height: u24le(view, 27) + 1,
    };
  }
  return undefined;
};

/**
 * JPEG's markers no segment before the first frame header may be (T.81
 * B.1.1.3, Table B.1): `FF 00`, which only stuffs entropy-coded data;
 * the reserved 0x02 to 0xBF; RST0 to RST7, which only sit in a scan; a
 * second SOI; and EOI and SOS, which end the file or start a scan before
 * any frame was declared. TEM (0x01) stands alone and is stepped over.
 */
const isRefusedBeforeFrame = (marker: number): boolean =>
  marker === 0x00 ||
  (marker >= 0x02 && marker <= 0xbf) ||
  (marker >= 0xd0 && marker <= 0xda);

/** JPEG's start-of-frame markers, SOF0 to SOF15 but DHT, JPG and DAC. */
const isStartOfFrame = (marker: number): boolean =>
  marker >= 0xc0 &&
  marker <= 0xcf &&
  marker !== 0xc4 &&
  marker !== 0xc8 &&
  marker !== 0xcc;

/**
 * A JPEG's frame header at `at` (T.81 B.2.2): its length, which is 8 and
 * three bytes a component and fits in the file, the precision, then the
 * height and width as two-byte big-endian numbers, then the count of
 * components.
 */
const jpegFrame = (
  bytes: Uint8Array,
  view: DataView,
  at: number
): LogoHeader | undefined => {
  if (at + 10 > bytes.length) {
    return undefined;
  }
  const length = view.getUint16(at + 2);
  const components = view.getUint8(at + 9);
  return length === 8 + 3 * components && at + 2 + length <= bytes.length
    ? {
        type: "image/jpeg",
        height: view.getUint16(at + 5),
        width: view.getUint16(at + 7),
      }
    : undefined;
};

/**
 * A JPEG's size, from its frame header (ITU T.81 B.1.1, B.2.2): the
 * segments after SOI are walked by their lengths, each at least 2 and
 * within the file, to the first SOF. None when a marker that can't come
 * before it, or the end, comes first.
 */
const jpegHeader = (bytes: Uint8Array): LogoHeader | undefined => {
  if (!holds(bytes, [0xff, 0xd8])) {
    return undefined;
  }
  const view = viewOf(bytes);
  let at = 2;
  while (at + 2 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      return undefined;
    }
    const marker = view.getUint8(at + 1);
    if (marker === 0xff) {
      // A fill byte before the marker.
      at += 1;
    } else if (marker === 0x01) {
      at += 2;
    } else if (isRefusedBeforeFrame(marker)) {
      return undefined;
    } else if (isStartOfFrame(marker)) {
      return jpegFrame(bytes, view, at);
    } else {
      const length = at + 4 <= bytes.length ? view.getUint16(at + 2) : 0;
      if (length < 2 || at + 2 + length > bytes.length) {
        return undefined;
      }
      at += 2 + length;
    }
  }
  return undefined;
};

/** What `bytes` say they are, by their header; none for anything else. */
const logoHeaderOf = (bytes: Uint8Array): LogoHeader | undefined =>
  pngHeader(bytes) ?? jpegHeader(bytes) ?? webpHeader(bytes);

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
