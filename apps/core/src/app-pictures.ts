import { versionErrors } from "@grasp-os/shared/app-releases";
import {
  appErrors,
  appPictureMaxBytes,
  appPictureMaxPixels,
  appPicturePath,
  appPicturesPrefix,
  appPictureTypes,
} from "@grasp-os/shared/apps";
import type { AppPictureType } from "@grasp-os/shared/apps";
import {
  authErrors,
  isExpectedError,
  requestErrors,
} from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  appFor,
  appKind,
  changeEntry,
  findVersion,
  isPublished,
  pictureKey,
  picturesPrefix,
  publishedSql,
} from "./apps.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { identify } from "./auth/identity.ts";
import { appVersions } from "./db/core/schema.ts";
import { errorResponse } from "./errors.ts";
import {
  imageAnimated,
  imageEnded,
  imageHeaderOf,
} from "./files/image-header.ts";
import { routeMember } from "./staff-audit.ts";

// A picture of each published App version, for the Apps overview's cards
// (GRA-1994): the builder's browser takes it from the preview as they
// publish, and hands core its bytes (`setVersionPicture`). Core renders
// nothing. Each set is an object of its own in the files bucket (EU),
// under a new ID (apps.ts, `pictureKey`), with the type its bytes told;
// the version's row names the one it has now (`app_versions.picture`),
// and only that one is ever served.
//
// How it can go wrong, and what stops it:
// - Someone who may not publish the App sets one: a builder of another
//   App, a user of this one, a guest (whom `/rpc` answers as nobody here),
//   Grasp staff (refused on every App call, session-check.ts). Only whoever
//   publishing lets in (`appKind.editable`, as publish.ts asks), and the
//   write lands only while that still holds and the App isn't archived
//   (`appKind.stillEditable`), as a draft's does. Its bytes are their own
//   object, served only once that write named it: a set refused between
//   the check and the write changes nothing anyone sees.
// - Two sets at once: each puts its own object, and the row ends naming
//   the one whose write committed last, which the last audit event names
//   too. Each deletes, once its write committed, the object the row named
//   just before it, read in the same batch; a refused or failed set
//   deletes only its own.
// - A picture for a version that never went out, or of another App: the
//   version is looked up under the App the call names, and must be
//   published, when it is checked and again in the write
//   (`publishedSql`).
// - A file a browser would run: an SVG, HTML named .png. Only PNG, JPEG
//   and WebP are taken, told by their header; the call takes bytes alone.
//   It is served only as the type found then, kept with the bytes, with
//   `nosniff` and a policy that runs and loads nothing
//   (security-headers.ts), so a polyglot runs nowhere either.
// - One large enough to hurt, or broken: refused past 2 MB, past 4000
//   pixels a side, with no pixels, or cut short (`imageEnded`).
// - Someone who may not open the App reading it: the route serves only a
//   signed-in member who may open it (`appFor`, as `apps.get` asks: a
//   role in it, and able to read what it read), and anyone else, or any
//   version without one, is not found; the overview names it only to them
//   too (apps.ts, `listAppOverviews`). Guests and staff are nobody to it
//   (`routeMember`), staff's asking audited. The browser keeps no copy:
//   access taken away applies at once.
// - It outliving its App: removing the App deletes every picture under it
//   (app-removal.ts). A replaced picture's object goes once the write
//   that replaced it committed; should that delete fail, it is left,
//   named by nothing and served to nobody, until the App is removed.
// - Going unrecorded: each set is one audit event, with the version, the
//   picture's ID, type and size, in the batch that names it.

/** Whether `type` is one an App's picture may be: never a GIF. */
const isPictureType = (type: string): type is AppPictureType =>
  appPictureTypes.some((allowed) => allowed === type);

/** `image`, checked: a whole, still PNG, JPEG or WebP within the limits, and its type. */
const checkedPicture = (
  image: unknown
): { bytes: Uint8Array; type: AppPictureType } => {
  if (!(image instanceof Uint8Array) || image.byteLength > appPictureMaxBytes) {
    throw appErrors.create("app.picture_invalid");
  }
  const header = imageHeaderOf(image);
  if (
    header === undefined ||
    !isPictureType(header.type) ||
    header.width < 1 ||
    header.height < 1 ||
    header.width > appPictureMaxPixels ||
    header.height > appPictureMaxPixels ||
    !imageEnded(image, header.type) ||
    imageAnimated(image, header.type)
  ) {
    throw appErrors.create("app.picture_invalid");
  }
  return { bytes: image, type: header.type };
};

/**
 * Deletes the object at `key`, a picture nothing names (any more). It
 * never fails: should the bucket fail, the object is left, served to
 * nobody.
 */
const forget = async (env: Env, key: string): Promise<void> => {
  try {
    await env.FILES.delete(key);
  } catch (error) {
    log.warn("app.picture_forget_failed", { key, ...errorFields(error) });
  }
};

/**
 * Keeps `image` as the picture of `versionInput` of the App `input`
 * names, a published version, for `by`, who may publish the App, in place
 * of any it had, audited: where it is read (`appPicturePath`).
 */
export const setVersionPicture = async (
  env: Env,
  by: Identity,
  input: unknown,
  versionInput: unknown,
  image: unknown
): Promise<string> => {
  // Whoever publishing lets in, as publish.ts asks.
  const app = appIdSchema.parse(await appKind.editable(env, by, input));
  const { version } = await findVersion(env, app, versionInput);
  if (!(await isPublished(env, app, version))) {
    throw versionErrors.create("version.unpublished");
  }
  const { bytes, type } = checkedPicture(image);
  const picture = crypto.randomUUID();
  const key = pictureKey(app, version, picture);
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: type } });
  const db = drizzle(env.DB);
  const ofVersion = and(
    eq(appVersions.appId, app),
    eq(appVersions.version, version)
  );
  let before: { picture: string | null }[];
  let changed: { version: number }[];
  try {
    [before, changed] = await auditedBatch(env, db, [
      // The picture it replaces, read in the batch that replaces it.
      db
        .select({ picture: appVersions.picture })
        .from(appVersions)
        .where(ofVersion),
      db
        .update(appVersions)
        .set({ picture })
        .where(
          and(
            ofVersion,
            publishedSql(app, version),
            appKind.stillEditable(app, by)
          )
        )
        .returning({ version: appVersions.version }),
      outboxedIfChanged(
        db,
        changeEntry(by, "app.version.picture_set", app, {
          version,
          picture,
          type,
          bytes: bytes.byteLength,
        })
      ),
    ]);
  } catch (error) {
    await forget(env, key);
    throw error;
  }
  if (changed.length === 0) {
    await forget(env, key);
    // Taken away since it was checked: refused as such.
    await appKind.editable(env, by, app);
    if (!(await isPublished(env, app, version))) {
      throw versionErrors.create("version.unpublished");
    }
    throw appErrors.create("app.conflict");
  }
  const replaced = before[0]?.picture;
  if (replaced !== null && replaced !== undefined) {
    await forget(env, pictureKey(app, version, replaced));
  }
  return appPicturePath(app, version);
};

/**
 * Deletes every picture of App `app`'s versions, as its removal does
 * (app-removal.ts).
 */
export const deletePictures = async (env: Env, app: AppId): Promise<void> => {
  const prefix = picturesPrefix(app);
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- page after page
    const listed = await env.FILES.list({ prefix, limit: 1000 });
    if (listed.objects.length === 0) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- page after page
    await env.FILES.delete(listed.objects.map(({ key }) => key));
    if (!listed.truncated) {
      return;
    }
  }
};

/** `/api/app-pictures/<app>/<version>`: a picture of an App version. */
const picturePattern = new RegExp(
  `^${appPicturesPrefix}(?<app>[^/]+)/(?<version>[1-9]\\d{0,8})$`,
  "u"
);

/** `part` decoded from a path; `undefined` for one that isn't encoded right. */
const decoded = (part: string): string | undefined => {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
};

/**
 * Whether `person` may open App `app` (`appFor`, as `apps.get` asks):
 * false for one it isn't there for, whatever the reason.
 */
const mayOpen = async (
  env: Env,
  person: Identity,
  app: string
): Promise<boolean> => {
  try {
    await appFor(env, person, app, "user");
    return true;
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    throw error;
  }
};

/**
 * The picture of an App version, to a signed-in member who may open the
 * App, as the type core found, never kept by the browser. Anyone not
 * signed in is told to; anyone else, and any version without one, is not
 * found. Undefined for any other path.
 */
export const appPictureResponse = async (
  pathname: string,
  request: Request,
  env: Env,
  requestId: string
): Promise<Response | undefined> => {
  const match = picturePattern.exec(pathname)?.groups;
  if (match === undefined) {
    return undefined;
  }
  const notFound = () =>
    errorResponse(404, requestErrors.create("request.not_found"), requestId);
  const app = decoded(match.app ?? "");
  const version = Number(match.version);
  if (request.method !== "GET" || app === undefined) {
    return notFound();
  }
  const person = await routeMember(
    env,
    await identify(env, request.headers),
    "app.picture",
    { app, version }
  );
  if (person === undefined) {
    return errorResponse(
      401,
      authErrors.create("auth.unauthenticated"),
      requestId
    );
  }
  if (!(await mayOpen(env, person, app))) {
    return notFound();
  }
  const id = appIdSchema.parse(app);
  const row = await drizzle(env.DB)
    .select({ picture: appVersions.picture })
    .from(appVersions)
    .where(and(eq(appVersions.appId, id), eq(appVersions.version, version)))
    .get();
  // The one the row names now, never another set's.
  const kept =
    row?.picture === null || row?.picture === undefined
      ? null
      : await env.FILES.get(pictureKey(id, version, row.picture));
  // Its type as it was found, kept with these very bytes.
  const type = kept?.httpMetadata?.contentType;
  if (kept === null || type === undefined || !isPictureType(type)) {
    await kept?.body.cancel();
    return notFound();
  }
  // `nosniff` and a policy that runs nothing come with every answer on
  // this path (security-headers.ts).
  return new Response(kept.body, {
    headers: {
      "content-type": type,
      "content-length": String(kept.size),
      "cache-control": "private, no-store",
    },
  });
};
