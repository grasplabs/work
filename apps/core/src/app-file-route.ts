import type { FilesOperation } from "@grasp-os/sdk";
import { schemaHash } from "@grasp-os/sdk/host";
import {
  appFilesPath,
  downloadNameOf,
  fileChunkHashHeader,
  fileLimits,
  isPreviewable,
  TextCheck,
  typeOfBytes,
} from "@grasp-os/shared/app-file-limits";
import type { FileType } from "@grasp-os/shared/app-file-limits";
import { deleteFileSchema, fileErrors } from "@grasp-os/shared/app-files";
import type { UploadState } from "@grasp-os/shared/app-files";
import { versionErrors } from "@grasp-os/shared/app-releases";
import { auditEventSchema } from "@grasp-os/shared/audit";
import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import {
  authErrors,
  internalErrors,
  isExpectedError,
  requestErrors,
} from "@grasp-os/shared/errors";
import { readAtMost } from "@grasp-os/shared/http";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { screenErrors, screenLeaseHeader } from "@grasp-os/shared/screens";
import { not } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { operationRoles } from "./app-access.ts";
import { loadRelease } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";
import { appFor } from "./apps.ts";
import {
  auditedBatch,
  outboxedEventWhere,
  storedEvent,
  uuidFromHash,
} from "./audit-outbox.ts";
import { identify } from "./auth/identity.ts";
import { storeFiles } from "./data-stores.ts";
import { appHost } from "./durable-objects.ts";
import { errorResponse } from "./errors.ts";
import type {
  ChunkRecord,
  FileContent,
  FileReader,
  Publishable,
} from "./file-host.ts";
import { requireNotRevoked } from "./release-runner.ts";
import { isOwnOrigin } from "./rpc.ts";
import { delivering, leasedArtifact, personRefusal } from "./screen-trust.ts";
import { admitted } from "./screens-rpc.ts";

// Core's file channel (spec 10.7.5): how a running App's screen, through
// its page, moves the bytes of its App's files, which never travel in a
// JSON call. `<appFilesPath>/<app>/<alias>/…`, `<alias>` the files
// resource the App declares:
//
// - `POST   uploads`                       starts an upload (name, type, size, hash)
// - `GET    uploads/<file>`                where it is, to resume it
// - `PUT    uploads/<file>/chunks/<index>` one chunk of its bytes
// - `POST   uploads/<file>/finish`         checks and publishes it
// - `DELETE uploads/<file>`                cancels it
// - `GET    files/<file>`                  what a file is
// - `GET    files/<file>/content`          its bytes, as an attachment
// - `GET    files/<file>/preview`          a previewable image's bytes
// - `POST   files/<file>/delete`           deletes it
//
// The store's file host decides what each may do to which file
// (file-host.ts, with its threat model); this route decides who is asking
// and through what. Threat model, and how each is closed:
//
// - Another site acts in the person's name: every request needs the
//   frame's lease in a header, verified for the person and App whatever
//   the App's data (no form or link sends one, and a script on
//   another site can't without a preflight core never answers), a fetch
//   from another site is refused by its `Sec-Fetch-Site`, and every request
//   that changes anything needs the deployment's own `Origin`.
// - The frame was opened for one person and the browser's cookie is now
//   someone else's: the page names the person its frame is for, and a
//   request of anyone else is refused before it is counted or read
//   (`personRefusal`), as a function call is.
// - Someone without a role in the App, or who lost it, or a build nobody
//   approved: the session is read on every request, the role checked
//   (`appFor`), the release of the App's current version checked not
//   revoked, and the request runs inside `delivering`, which checks the
//   lease's build is still trusted before and after. A download decides
//   again, before every chunk, whether the reader may read the file now
//   (their roles, the records holding it, its tombstone) and the build is
//   trusted, and ends after `fileLimits.downloadMs`, so a revocation, a
//   lost role, a detachment or a deletion fences the bytes still to come.
// - A screen does what its App didn't declare: each request needs its
//   resource's operation (`upload`, `read` or `delete`) in the sealed
//   release's `resource.files` declaration, never in what the request says.
// - A flood: each request but a chunk counts against the person's
//   requests of the App's screens (`admitted`); each chunk against a
//   chunk budget of its own (`AppHost.admitChunk`), charged before it is
//   read or anything is looked up, a refused or repeated one too. What is
//   kept is bounded by the store's quotas (file-host.ts, `begin`).
// - A chunk larger than it says, or other bytes than it says: the body is
//   read no further than its chunk's size, which must be exact, and
//   checked against its hash before it is kept. The whole file is checked
//   against its declared hash, size and type before it is published.
// - A file runs on the product's origin, or once saved: bytes are only
//   ever sent as an attachment, with the type the host checked them to be
//   (never one a browser runs), `nosniff` and a sandboxing policy
//   (security-headers.ts), never cached, and saved under a name ending in
//   that type's extension, with no invisible formatting (`downloadNameOf`).
// - Nobody can tell who read someone else's file: a download, or a
//   preview, by anyone but its uploader is audited, each as what it was,
//   once a day per person and file.

/** A file channel request, as its path names it. */
type FileRequest =
  | { readonly kind: "begin" }
  | { readonly kind: "status" | "cancel" | "finish"; readonly file: string }
  | { readonly kind: "chunk"; readonly file: string; readonly index: number }
  | {
      readonly kind: "describe" | "content" | "preview" | "delete";
      readonly file: string;
    };

/** Where a request is, as the path names it. */
export interface FileRoute {
  readonly app: string;
  readonly resource: string;
  readonly request: FileRequest;
}

const segment = /^[A-Za-z0-9_-]{1,64}$/u;
const chunkIndex = /^(?:0|[1-9][0-9]{0,5})$/u;

/** What `method` asks of the upload path after `uploads`. */
const uploadRequestOf = (
  method: string,
  file: string | undefined,
  part: string | undefined,
  index: string | undefined
): FileRequest | undefined => {
  const route = `${method} ${file === undefined ? "" : "file"}${part === undefined ? "" : `/${part}`}${index === undefined ? "" : "/index"}`;
  switch (route) {
    case "POST ": {
      return { kind: "begin" };
    }
    case "GET file": {
      return file === undefined ? undefined : { kind: "status", file };
    }
    case "DELETE file": {
      return file === undefined ? undefined : { kind: "cancel", file };
    }
    case "POST file/finish": {
      return file === undefined ? undefined : { kind: "finish", file };
    }
    case "PUT file/chunks/index": {
      return file === undefined ||
        index === undefined ||
        !chunkIndex.test(index)
        ? undefined
        : { kind: "chunk", file, index: Number(index) };
    }
    default: {
      return undefined;
    }
  }
};

/** What `method` asks of the path of file `file` (`part` after it). */
const fileRequestOf = (
  method: string,
  file: string,
  part: string | undefined
): FileRequest | undefined => {
  switch (`${method} ${part ?? ""}`) {
    case "GET ": {
      return { kind: "describe", file };
    }
    case "GET content": {
      return { kind: "content", file };
    }
    case "GET preview": {
      return { kind: "preview", file };
    }
    case "POST delete": {
      return { kind: "delete", file };
    }
    default: {
      return undefined;
    }
  }
};

/**
 * The file channel request `pathname` names with `method`; `not_found`
 * for a path under the channel that names none; undefined for any other
 * path.
 */
export const fileRouteOf = (
  pathname: string,
  method: string
): FileRoute | "not_found" | undefined => {
  const prefix = `${appFilesPath}/`;
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const [app = "", resource = "", kind, file, part, index, ...more] = pathname
    .slice(prefix.length)
    .split("/");
  let request: FileRequest | undefined;
  if (more.length === 0 && kind === "uploads") {
    request = uploadRequestOf(method, file, part, index);
  } else if (
    more.length === 0 &&
    kind === "files" &&
    file !== undefined &&
    index === undefined
  ) {
    request = fileRequestOf(method, file, part);
  }
  const named =
    segment.test(app) &&
    segment.test(resource) &&
    (request === undefined ||
      !("file" in request) ||
      segment.test(request.file));
  return request !== undefined && named
    ? { app, resource, request }
    : "not_found";
};

/** The operation a request needs its resource to declare. */
const operationOf = (request: FileRequest): FilesOperation => {
  if (
    request.kind === "describe" ||
    request.kind === "content" ||
    request.kind === "preview"
  ) {
    return "read";
  }
  return request.kind === "delete" ? "delete" : "upload";
};

/** The HTTP status of each refusal that isn't a plain 403. */
const statuses: Readonly<Record<string, number>> = {
  "screen.rate_limited": 429,
  // A chunk write too slow to settle: lost, for the page to send again.
  "internal.unexpected": 503,
  "auth.unauthenticated": 401,
  "auth.principal_changed": 401,
  "app.not_found": 404,
  "file.not_found": 404,
  "file.upload_expired": 410,
  "file.too_large": 413,
  "file.invalid": 422,
  "file.type_unsupported": 422,
  "file.content_mismatch": 422,
  "request.too_large": 413,
  "file.referenced": 409,
  "file.cancelled": 409,
  "file.incomplete": 409,
  "file.uploads_open": 409,
  "submission.key_conflict": 409,
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
  return request.method === "GET" || isOwnOrigin(request, env);
};

/** The longest JSON body the channel reads: a start's or a deletion's. */
const jsonMaxBytes = 4096;

/** A request's body, as the byte stream workerd gives it. */
const bodyOf = (request: Request): ReadableStream<Uint8Array> | null =>
  request.body;

/** A JSON request body, read no further than `jsonMaxBytes`. */
const jsonBody = async (request: Request): Promise<unknown> => {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  ) {
    throw fileErrors.create("file.invalid");
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
    throw fileErrors.create("file.invalid");
  }
};

/** The SHA-256 of `bytes`, as lower-case hex. */
const sha256Of = async (bytes: Uint8Array): Promise<string> =>
  toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))
  );

/**
 * Whether the chunks of an upload are, together, the file it declared:
 * its size and hash, and bytes of its type (text all UTF-8, no NUL).
 * Read one chunk at a time, in order.
 */
const verify = async (env: Env, upload: Publishable): Promise<boolean> => {
  const digest = new crypto.DigestStream("SHA-256");
  const writer = digest.getWriter();
  const text = new TextCheck();
  const isText =
    upload.mimeType === "text/plain" || upload.mimeType === "text/csv";
  let size = 0;
  for (const [index, chunk] of upload.chunks.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- the file's bytes, in order
    const object = await env.FILES.get(chunk.key);
    // oxlint-disable-next-line no-await-in-loop -- the file's bytes, in order
    const bytes = object === null ? null : await object.bytes();
    size += bytes?.byteLength ?? 0;
    const fits =
      bytes !== null &&
      // The object is the one recorded, as recorded.
      // oxlint-disable-next-line no-await-in-loop -- the file's bytes, in order
      (await sha256Of(bytes)) === chunk.sha256 &&
      size <= upload.size &&
      (index > 0 || typeOfBytes(bytes, upload.mimeType) !== undefined) &&
      (!isText || text.add(bytes));
    if (!fits) {
      // Closed, not aborted: an aborted digest's promise would reject
      // with nobody waiting for it.
      // oxlint-disable-next-line no-await-in-loop -- once, then out
      await writer.close();
      // oxlint-disable-next-line no-await-in-loop -- once, then out
      await digest.digest;
      return false;
    }
    // oxlint-disable-next-line no-await-in-loop -- the file's bytes, in order
    await writer.write(bytes);
  }
  await writer.close();
  const hash = toHex(new Uint8Array(await digest.digest));
  return (
    size === upload.size && hash === upload.sha256 && (!isText || text.end())
  );
};

const isUploadState = (
  value: Publishable | UploadState
): value is UploadState => "state" in value;

/** What RFC 8187's attr-char leaves out and `encodeURIComponent` doesn't. */
const notAttrChar = /['()*]/gu;

/**
 * `Content-Disposition` for a file of `type` stored as `name`: an
 * attachment, saved under `downloadNameOf` it (its type's extension, no
 * invisible formatting), ASCII first and the name in full after.
 */
const contentDisposition = (name: string, type: FileType): string => {
  const saved = downloadNameOf(name, type);
  const fallback = saved.replaceAll(/[^\u0020-\u007E]|["\\]/gu, "_");
  const encoded = encodeURIComponent(saved).replaceAll(
    notAttrChar,
    (character) =>
      `%${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

/** The `Content-Type` a file of `type` is sent with. */
const contentTypeOf = (type: FileType): string =>
  type.startsWith("text/") ? `${type}; charset=utf-8` : type;

/**
 * The release of the App's current version, for a person with a role in
 * it, not revoked, declaring `resource` as files with `operation`; and
 * its store. Refused otherwise, as each check says.
 */
const resolved = async (
  env: Env,
  person: Identity,
  app: AppId,
  resource: string,
  operation: FilesOperation
) => {
  const found = await appFor(env, person, app, "user");
  if (found.currentVersion === null) {
    throw versionErrors.create("version.not_sealed");
  }
  const release: Release = await loadRelease(
    env,
    found.id,
    found.currentVersion
  );
  await requireNotRevoked(env, found.id, found.currentVersion);
  const declared = Object.hasOwn(release.app.browserResources, resource)
    ? release.app.browserResources[resource]
    : undefined;
  if (
    declared?.["~resource"] !== "files" ||
    !declared.operations.includes(operation)
  ) {
    throw fileErrors.create("file.operation_denied");
  }
  if (release.store === null) {
    throw fileErrors.create("file.unavailable");
  }
  const { storeId, stub } = await storeFiles(env, release.store.storeId);
  return { release, version: found.currentVersion, storeId, stub };
};

/** What every request of the channel works with, once admitted. */
interface Channel {
  readonly env: Env;
  readonly request: Request;
  readonly storeId: Awaited<ReturnType<typeof storeFiles>>["storeId"];
  readonly stub: Awaited<ReturnType<typeof storeFiles>>["stub"];
  readonly principal: string;
  readonly resource: string;
  /** Runs `work` while the lease's build is trusted, before and after. */
  readonly within: <Answer>(work: () => Promise<Answer>) => Promise<Answer>;
  /**
   * Who reads, as the App's operations do: their roles now, its schema.
   * Asked again for each chunk of a download: refused once the session
   * ended or is someone else's, or the App's current release is no
   * longer the one the request began on, or it was revoked.
   */
  readonly reader: () => Promise<FileReader>;
}

/**
 * The key the store recorded for chunk `index` of `file` (null for none),
 * or undefined when that can't be known now either.
 */
const recordedKey = async (
  stub: Channel["stub"],
  storeId: Channel["storeId"],
  principal: string,
  file: string,
  index: number
): Promise<string | null | undefined> => {
  try {
    return await stub.chunkKey(storeId, principal, file, index);
  } catch (error) {
    log.warn("app_file.chunk_unknown", errorFields(error));
    return undefined;
  }
};

/**
 * Keeps one chunk of an upload: read no further than a chunk may be,
 * checked against the hash it carries, then admitted by the file host
 * (exactly the size its place says), which names an R2 key of this
 * write's own, and recorded once it is stored. A write that isn't
 * recorded (the upload ended, another write of the chunk was recorded
 * first, the store is gone) or fails on the way removes its own object,
 * which nothing else names. A chunk core holds already is answered
 * without being stored again.
 */
const receiveChunk = async (
  { env, request, storeId, stub, principal, resource }: Channel,
  file: string,
  index: number
): Promise<Response> => {
  const hash = request.headers.get(fileChunkHashHeader)?.toLowerCase();
  // Read no further than a chunk may be, whatever the request says of its
  // length; then held to the size its place says (`admitChunk`).
  const stream = bodyOf(request);
  const bytes =
    stream === null
      ? undefined
      : await readAtMost(stream, fileLimits.chunkBytes);
  if (
    hash === undefined ||
    bytes === undefined ||
    bytes.byteLength === 0 ||
    (await sha256Of(bytes)) !== hash
  ) {
    throw fileErrors.create("file.content_mismatch");
  }
  const declared = bytes.byteLength;
  const key = await stub.admitChunk(
    storeId,
    principal,
    resource,
    file,
    index,
    declared,
    hash
  );
  if (key === null) {
    return Response.json({ kept: true });
  }
  try {
    await env.FILES.put(key, bytes);
  } catch (error) {
    // Nothing recorded names a key before `chunkStored`: removed.
    await env.FILES.delete(key);
    throw error;
  }
  let record: ChunkRecord;
  try {
    record = await stub.chunkStored(
      storeId,
      principal,
      file,
      index,
      declared,
      hash,
      key
    );
  } catch (error) {
    // The answer was lost, and may have been a commit: the object is
    // removed only once the store says the chunk isn't recorded under its
    // key, and kept when it is. Should even that not be known, it stays,
    // until the store's alarm removes it unless it is recorded
    // (`fileWrites`, file-host.ts); the page resumes from what the store
    // says it holds.
    const recorded = await recordedKey(stub, storeId, principal, file, index);
    if (recorded === key) {
      return Response.json({ kept: true });
    }
    if (recorded !== undefined) {
      await env.FILES.delete(key);
    }
    throw error;
  }
  // A write that isn't the chunk's removes its own object, never the one
  // another write recorded.
  if (record !== "recorded") {
    await env.FILES.delete(key);
  }
  // The same bytes recorded by another write (one sent again while the
  // first still ran) are this chunk kept; other bytes are a mismatch.
  if (record === "mismatch") {
    throw fileErrors.create("file.content_mismatch");
  }
  if (record === "ended") {
    throw fileErrors.create("file.cancelled");
  }
  // A write too slow to settle, its upload still open: answered as a lost
  // one is, so the page asks which chunks core holds and sends this again.
  if (record === "expired") {
    throw internalErrors.create("internal.unexpected");
  }
  return Response.json({ kept: true });
};

/** Checks an upload whose chunks all arrived, and publishes it if it passes. */
const finish = async (
  { env, storeId, stub, principal, resource }: Channel,
  file: string
): Promise<UploadState> => {
  const upload = await stub.publishable(storeId, principal, resource, file);
  if (isUploadState(upload)) {
    return upload;
  }
  let verified: boolean;
  try {
    verified = await verify(env, upload);
  } catch (error) {
    // The check couldn't say: the next finish checks again at once.
    await stub.abandonFinish(storeId, principal, resource, file, upload.claim);
    throw error;
  }
  return await stub.publish(
    storeId,
    principal,
    resource,
    file,
    verified,
    upload.claim
  );
};

/**
 * Records that `reader` downloaded or previewed `content` (`action`), if
 * they aren't its uploader: once a day per person, file and action (the
 * event's ID is derived from them), as access to someone else's document.
 * Descriptions aren't audited.
 */
const auditDownload = async (
  env: Env,
  storeId: string,
  reader: string,
  content: FileContent,
  action: "file.downloaded" | "file.previewed"
): Promise<void> => {
  if (reader === content.ownerId) {
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  const event = auditEventSchema.parse({
    id: uuidFromHash(
      await sha256Hex(`${action}:${storeId}:${content.id}:${reader}:${day}`)
    ),
    // The same event however often that day: one sent again after the
    // first was logged (its outbox row gone) is a duplicate the log drops,
    // never one that conflicts with it. The log records when it came.
    at: `${day}T00:00:00.000Z`,
    source: "core",
    actor: { type: "person", userId: reader },
    action,
    target: { type: "file", id: content.id },
    detail: { store: storeId, uploadedBy: content.ownerId, day },
  });
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxedEventWhere(db, event, not(storedEvent(event.id))),
  ]);
};

/**
 * A readable file's bytes, as an attachment, chunk by chunk, its recorded
 * chunks only: each chunk only while the reader may still read the file,
 * as decided again with their roles now, the build is still trusted, and
 * the download is within its time (`fileLimits.downloadMs`).
 */
const contentResponse = async (
  { env, storeId, stub, resource, within, reader }: Channel,
  file: string,
  preview = false
): Promise<Response> => {
  const reading = await reader();
  const content = await within(
    async () => await stub.fileContent(storeId, reading, resource, file)
  );
  // A preview is a previewable image the page shows in the frame, audited
  // as one: anything else is read only as a download.
  if (preview && !isPreviewable(content.mimeType, content.size)) {
    throw fileErrors.create("file.invalid");
  }
  await auditDownload(
    env,
    storeId,
    reading.principal,
    content,
    preview ? "file.previewed" : "file.downloaded"
  );
  const endsAt = Date.now() + fileLimits.downloadMs;
  let next = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        const chunk = content.chunks[next];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        next += 1;
        if (Date.now() > endsAt) {
          throw fileErrors.create("file.not_found");
        }
        // Its bytes read inside the trust check, which looks again once
        // they are: a build revoked while they came delivers none of them.
        const bytes = await within(async () => {
          const now = await stub.fileContent(
            storeId,
            await reader(),
            resource,
            file
          );
          const key = now.chunks[next - 1]?.key;
          const object = key === chunk.key ? await env.FILES.get(key) : null;
          if (object === null) {
            return null;
          }
          const read = await object.bytes();
          // Still the reader's to read once the bytes came: a file detached
          // or deleted meanwhile delivers none of them.
          const after = await stub.fileContent(
            storeId,
            await reader(),
            resource,
            file
          );
          return after.chunks[next - 1]?.key === chunk.key ? read : null;
        });
        // Nor past the download's time, however long they took.
        if (bytes === null || Date.now() > endsAt) {
          throw fileErrors.create("file.not_found");
        }
        controller.enqueue(bytes);
      },
    },
    // Nothing read ahead: each chunk is checked when it is asked for.
    { highWaterMark: 0 }
  );
  return new Response(body, {
    headers: {
      "content-type": contentTypeOf(content.mimeType),
      "content-disposition": contentDisposition(content.name, content.mimeType),
      "content-length": String(content.size),
      "cache-control": "private, no-store",
    },
  });
};

/** Answers `asked` on `channel`. */
const answer = async (
  channel: Channel,
  asked: FileRequest
): Promise<Response> => {
  const { request, storeId, stub, principal, resource, within, reader } =
    channel;
  switch (asked.kind) {
    case "begin": {
      const body = await jsonBody(request);
      return Response.json(
        await within(
          async () => await stub.beginUpload(storeId, principal, resource, body)
        )
      );
    }
    case "status": {
      return Response.json(
        await within(
          async () =>
            await stub.uploadStatus(storeId, principal, resource, asked.file)
        )
      );
    }
    case "cancel": {
      return Response.json(
        await within(
          async () =>
            await stub.cancelUpload(storeId, principal, resource, asked.file)
        )
      );
    }
    case "chunk": {
      return await within(
        async () => await receiveChunk(channel, asked.file, asked.index)
      );
    }
    case "finish": {
      return Response.json(
        await within(async () => await finish(channel, asked.file))
      );
    }
    case "describe": {
      const { id, name, mimeType, size } = await within(
        async () =>
          await stub.fileContent(storeId, await reader(), resource, asked.file)
      );
      return Response.json({ id, name, mimeType, size });
    }
    case "content": {
      return await contentResponse(channel, asked.file);
    }
    case "preview": {
      return await contentResponse(channel, asked.file, true);
    }
    case "delete": {
      const { idempotencyKey } = fileErrors.parse(
        "file.invalid",
        deleteFileSchema,
        await jsonBody(request)
      );
      await within(async () => {
        await stub.deleteFile(
          storeId,
          principal,
          resource,
          asked.file,
          idempotencyKey
        );
      });
      return Response.json({ deleted: true });
    }
    default: {
      throw requestErrors.create("request.not_found");
    }
  }
};

/**
 * A request of core's file channel (see the header), for the person
 * signed in, as their screen running the build its lease names.
 */
export const appFileResponse = async (
  request: Request,
  env: Env,
  route: FileRoute,
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
  // Someone other than the person the frame is for, before anything is
  // counted or read.
  const refusal = personRefusal(request.headers, person.userId);
  if (refusal !== undefined) {
    log.info("app_file.person_refused", { requestId, reason: refusal.code });
    return errorResponse(statusOf(refusal.code), refusal, requestId);
  }
  const { request: asked, resource } = route;
  try {
    // A chunk counts against a budget of its own, charged before anything
    // is looked up or read; everything else is a request of the person's
    // screens, counted before anything else is read.
    let app: AppId;
    if (asked.kind === "chunk") {
      const named = appIdSchema.safeParse(route.app);
      if (!named.success) {
        throw requestErrors.create("request.not_found");
      }
      if (!(await appHost(env, named.data).admitChunk(person.userId))) {
        throw screenErrors.create("screen.rate_limited");
      }
      const found = await appFor(env, person, named.data, "user");
      app = found.id;
    } else {
      app = await admitted(env, person, route.app);
    }
    const artifact = await leasedArtifact(
      env,
      person.userId,
      app,
      request.headers.get(screenLeaseHeader)
    );
    // A lease that doesn't verify, for this person and App, is no screen
    // of theirs, whatever the App's data: a screen of ordinary data runs
    // without one elsewhere, but never moves files.
    if (artifact === undefined) {
      throw requestErrors.create("request.forbidden");
    }
    const within = async <Answer>(
      work: () => Promise<Answer>
    ): Promise<Answer> =>
      await delivering(env, person, app, artifact, "file", work);
    const { release, version, storeId, stub } = await within(
      async () => await resolved(env, person, app, resource, operationOf(asked))
    );
    const reader = async (): Promise<FileReader> => {
      // The session, as it is now: a sign-out or a revoked session ends
      // a download between chunks.
      const now = await identify(env, request.headers);
      if (now?.userId !== person.userId) {
        throw authErrors.create("auth.unauthenticated");
      }
      // Pinned to the release it began on: another one current, or this
      // one revoked, delivers no more of it.
      const found = await appFor(env, now, app, "user");
      if (found.currentVersion !== version) {
        throw versionErrors.create("version.mismatch");
      }
      await requireNotRevoked(env, app, version);
      return {
        principal: now.userId,
        roles: await operationRoles(env, now, app),
        schemaHash: await schemaHash(release.app.schema),
      };
    };
    return await answer(
      {
        env,
        request,
        storeId,
        stub,
        principal: person.userId,
        resource,
        within,
        reader,
      },
      asked
    );
  } catch (error) {
    if (isExpectedError(error)) {
      return errorResponse(statusOf(error.code), error, requestId);
    }
    log.error("app_file.failed", { requestId, ...errorFields(error) });
    return errorResponse(
      500,
      internalErrors.create("internal.unexpected"),
      requestId
    );
  }
};
