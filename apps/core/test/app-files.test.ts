import type {
  FilesReference,
  Id,
  OperationReference,
  ReferenceKind,
} from "@grasp-os/sdk";
import { GraspError } from "@grasp-os/sdk/client";
import { fileChannel, GraspClient } from "@grasp-os/sdk/host";
import type { FileChannel, FileTransport } from "@grasp-os/sdk/host";
import {
  appFilesPath,
  fileChunkHashHeader,
  fileLimits,
} from "@grasp-os/shared/app-file-limits";
import { appIdSchema, storeIdSchema } from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { screenPersonHeader } from "@grasp-os/shared/screen-limits";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import { screenLeaseHeader } from "@grasp-os/shared/screens";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import type { DataStore } from "../src/data-store.ts";
import { finishClaimMs, purgeGraceMs } from "../src/file-host.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { StoreHost } from "../src/store-host.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { person as actingPerson } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { callAuth, routed, signedInApi } from "./sign-in.ts";

// An App's files (spec 9.6, 10.7.5, 32.5), through core's file channel as
// a running screen's page reaches it, and the App's own functions as its
// session client calls them: uploaded, checked, attached to a record with
// a revision, read and downloaded, deleted; and, from the threat model
// (core's file-host.ts and app-file-route.ts), every way that should
// fail: another person's upload, another App's, a guessed ID, a type or
// content that isn't what it says, a chunk that isn't the one it says, an
// upload that outlived its time, a cancellation that lost to publication,
// a deletion with a record still holding the file, a cleanup gone stale,
// and the rest of a download after its file was deleted.

const idp = mockIdp();

const files: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({
    title: v.string().trim().min(1).max(200),
    attachments: v.array(v.file()).max(20).default([]),
  }),
  vault: defineTable({ file: v.file() }),
  board: defineTable({ file: v.file().nullable().default(null) }),
});
`,
  "operations/notes.ts": `import { AppError, v } from "@grasp-os/sdk";
import { doc, mutation, query } from "#grasp/server";

export const get = query({
  args: { id: v.id("notes") },
  returns: doc("notes").nullable(),
  handler: async (ctx, args) => await ctx.db.get("notes", args.id),
});

export const create = mutation({
  args: { title: v.string().trim().min(1).max(200) },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const attachFile = mutation({
  args: { id: v.id("notes"), expectedRevision: v.number().integer().min(1), file: v.file() },
  returns: doc("notes"),
  handler: async (ctx, args) => {
    const note = await ctx.db.get("notes", args.id, { expectedRevision: args.expectedRevision });
    if (!note) throw new AppError("note.not_found", "The note is unavailable.");
    if (note.attachments.some((file) => file.id === args.file.id)) return note;
    await ctx.db.patch("notes", args.id, { attachments: [...note.attachments, args.file] }, { expectedRevision: args.expectedRevision });
    const updated = await ctx.db.get("notes", args.id);
    if (!updated) throw new AppError("note.not_found", "The note is unavailable.");
    return updated;
  },
});

export const detachFile = mutation({
  args: { id: v.id("notes"), expectedRevision: v.number().integer().min(1), file: v.file() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const note = await ctx.db.get("notes", args.id, { expectedRevision: args.expectedRevision });
    if (!note) throw new AppError("note.not_found", "The note is unavailable.");
    await ctx.db.patch("notes", args.id, { attachments: note.attachments.filter((file) => file.id !== args.file.id) }, { expectedRevision: args.expectedRevision });
    return null;
  },
});

export const remove = mutation({
  args: { id: v.id("notes"), expectedRevision: v.number().integer().min(1) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete("notes", args.id, { expectedRevision: args.expectedRevision });
    return null;
  },
});

/** Moves a note's file to a new note, written first, then deletes the note. */
export const renew = mutation({
  args: { id: v.id("notes"), expectedRevision: v.number().integer().min(1), file: v.file() },
  returns: v.id("notes"),
  handler: async (ctx, args) => {
    const renewed = await ctx.db.insert("notes", { title: "Renewed", attachments: [args.file] });
    await ctx.db.delete("notes", args.id, { expectedRevision: args.expectedRevision });
    return renewed;
  },
});

/** Puts a file in the vault and on the board at once, in the order asked. */
export const keepTwice = mutation({
  args: { file: v.file(), vaultFirst: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.vaultFirst) {
      await ctx.db.insert("vault", { file: args.file });
      await ctx.db.insert("board", { file: args.file });
    } else {
      await ctx.db.insert("board", { file: args.file });
      await ctx.db.insert("vault", { file: args.file });
    }
    return null;
  },
});

/** Puts a file in the vault \`count\` times, in one commit. */
export const stashMany = mutation({
  args: { file: v.file(), count: v.number().integer().min(1).max(90) },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (let at = 0; at < args.count; at += 1) {
      await ctx.db.insert("vault", { file: args.file });
    }
    return null;
  },
});

/** Puts a file in the vault, which only the App's builders read. */
export const stash = mutation({
  args: { file: v.file() },
  returns: v.id("vault"),
  handler: async (ctx, args) => await ctx.db.insert("vault", { file: args.file }),
});

/** Pins a file to the board, which every member reads and writes. */
export const pin = mutation({
  args: { file: v.file() },
  returns: v.id("board"),
  handler: async (ctx, args) => await ctx.db.insert("board", { file: args.file }),
});

/** Pins a file named by its ID alone, as App code may make a reference. */
export const pinById = mutation({
  args: { fileId: v.string() },
  returns: v.id("board"),
  handler: async (ctx, args) => await ctx.db.insert("board", { file: { id: args.fileId } }),
});

/** Takes the file off a board entry, whoever pinned it. */
export const unpin = mutation({
  args: { id: v.id("board"), expectedRevision: v.number().integer().min(1), file: v.file() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("board", args.id, { file: null }, { expectedRevision: args.expectedRevision });
    return null;
  },
});
`,
  "app.ts": `import { app, resource } from "@grasp-os/sdk";
import { attachFile, create, detachFile, get, keepTwice, pin, pinById, remove, renew, stash, stashMany, unpin } from "./operations/notes.ts";
import schema from "./schema.ts";

export const attachments = resource.files("attachments", {
  operations: ["upload", "read", "attach", "delete"],
});

export const photos = resource.files("photos", { operations: ["read"] });

export const avatars = resource.files("avatars", { operations: ["upload", "read"] });

export default app({
  name: "Notes",
  schema,
  access: {
    tables: {
      notes: { read: "appMembers", write: "owner" },
      vault: { read: "appBuilders", write: "owner" },
      board: { read: "appMembers", write: "appMembers" },
    },
  },
  operations: { notes: { get, create, attachFile, detachFile, remove, renew, keepTwice, stash, stashMany, pin, pinById, unpin } },
  internalOperations: {},
  screens: [{ name: "notes", path: "/", source: "screens/notes.tsx" }],
  uses: [attachments, photos, avatars],
});
`,
  "screens/notes.tsx": `import { useFile, useUpload } from "@grasp-os/sdk/react";
import { resources } from "#grasp";

export default function Notes() {
  const upload = useUpload(resources.attachments);
  const shown = useFile(resources.attachments, upload.status === "completed" ? upload.file : "skip");
  return <p>{upload.status} {shown?.name ?? ""}</p>;
}
`,
};

/** A note as the App's queries return it. */
interface Note {
  _id: Id<"notes">;
  _rev: number;
  title: string;
  attachments: { id: string }[];
}

/** The reference to `path` of `release`, typed as `#grasp` types it. */
const referenceTo = <Args, Return, Kind extends ReferenceKind>(
  release: Release,
  path: string
): OperationReference<Args, Return, Kind> => {
  const operation = release.app.operations[path];
  const fingerprint = release.fingerprints[path];
  if (operation === undefined || fingerprint === undefined) {
    throw new Error(`The release has no ${path}`);
  }
  return {
    resourceId: release.manifest.resourceId,
    resourceVersion: release.manifest.resourceVersion,
    contractId: path,
    fingerprint,
    // SAFETY: each call below names the kind the release declares.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    kind: operation.kind as Kind,
    visibility: "public",
    mode: "single",
    args: operation.args,
    returns: operation.returns,
  };
};

interface FileArgs {
  id: Id<"notes">;
  expectedRevision: number;
  file: { id: string };
}

const apiOf = (release: Release) => ({
  get: referenceTo<{ id: Id<"notes"> }, Note | null, "query">(
    release,
    "notes.get"
  ),
  create: referenceTo<{ title: string }, Id<"notes">, "mutation">(
    release,
    "notes.create"
  ),
  attachFile: referenceTo<FileArgs, Note, "mutation">(
    release,
    "notes.attachFile"
  ),
  detachFile: referenceTo<FileArgs, null, "mutation">(
    release,
    "notes.detachFile"
  ),
  remove: referenceTo<
    { id: Id<"notes">; expectedRevision: number },
    null,
    "mutation"
  >(release, "notes.remove"),
  stash: referenceTo<{ file: { id: string } }, string, "mutation">(
    release,
    "notes.stash"
  ),
  pin: referenceTo<{ file: { id: string } }, string, "mutation">(
    release,
    "notes.pin"
  ),
  renew: referenceTo<
    { id: string; expectedRevision: number; file: { id: string } },
    string,
    "mutation"
  >(release, "notes.renew"),
  keepTwice: referenceTo<
    { file: { id: string }; vaultFirst: boolean },
    null,
    "mutation"
  >(release, "notes.keepTwice"),
  stashMany: referenceTo<
    { file: { id: string }; count: number },
    null,
    "mutation"
  >(release, "notes.stashMany"),
  pinById: referenceTo<{ fileId: string }, string, "mutation">(
    release,
    "notes.pinById"
  ),
  unpin: referenceTo<
    { id: string; expectedRevision: number; file: { id: string } },
    null,
    "mutation"
  >(release, "notes.unpin"),
});

/** The App's `resources`, as its screens import them from `#grasp`. */
const resources = {
  attachments: {
    kind: "files",
    alias: "attachments",
    operations: ["upload", "read", "attach", "delete"],
  },
  photos: { kind: "files", alias: "photos", operations: ["read"] },
} as const satisfies Record<string, FilesReference>;

const personApi = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personApi>>;

/** A builder's Notes App, made current, its screen approved by an admin. */
const releasedApp = async (builder: Person) => {
  const admin = await personApi("admin");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  const { version } = await builder.api.apps.files.commit(id, files, "First");
  await builder.api.apps.versions.setCurrent(id, version);
  const review = await admin.api.screenTrust.review(id);
  const artifacts = builtArtifacts(review.screens);
  await admin.api.screenTrust.approve(id, {
    version: review.version,
    generation: review.generation,
    artifacts,
  });
  return {
    app: id,
    release: await loadRelease(env, id, version),
    admin,
    artifacts,
  };
};

/**
 * `person`'s open screen of `app`: its lease, the person it names, and the
 * page's channel. A request the test sends itself names them too, unless
 * it names someone.
 */
const screenOf = async (person: Person, app: string) => {
  const { lease } = await person.api.screens.open(app, "notes");
  const fetch = async (path: string, init: RequestInit, coreEnv?: Env) => {
    const headers = new Headers(init.headers);
    headers.set("origin", clientOrigin);
    headers.set("cookie", person.session);
    if (!headers.has(screenPersonHeader)) {
      headers.set(screenPersonHeader, person.userId);
    }
    return await routed(path, { ...init, headers }, coreEnv);
  };
  const named = async () => await Promise.resolve(person.userId);
  return {
    lease,
    person: person.userId,
    named,
    fetch,
    channel: fileChannel({ app, lease, person: named, fetch }),
  };
};

/** What the browser downloaded: each file's bytes, by ID. */
type Downloads = Map<string, Uint8Array>;

/**
 * The page's file transport over `channel`, as the frame's file port
 * reaches it (apps/web's screen-files.ts): a download read to its end,
 * as the browser's own download would.
 */
const pageFiles = (
  channel: FileChannel,
  downloads: Downloads
): FileTransport => ({
  upload: channel.upload,
  read: async (resource, file, signal) => {
    const description = await channel.describe(resource, file, signal);
    const content = await channel.preview(resource, file, signal);
    return { description, preview: await content.blob() };
  },
  download: async (resource, file, signal) => {
    const response = await channel.content(resource, file, signal);
    downloads.set(file, await response.bytes());
  },
  delete: channel.delete,
});

type Screen = Awaited<ReturnType<typeof screenOf>>;

/**
 * The session client of `screen` of `app`, as the frame's runtime mounts
 * it, over the page's relay of its calls and files; and what it
 * downloaded.
 */
const clientOf = (screen: Screen, app: string) => {
  const downloads: Downloads = new Map();
  const client = new GraspClient({
    call: async (request) => {
      const response = await screen.fetch(`/api/app-functions/${app}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [screenLeaseHeader]: screen.lease,
          [screenPersonHeader]: screen.person,
        },
        body: request,
      });
      return await response.json();
    },
    // These tests read and change; none follows a query.
    watch: async () => await Promise.reject(new Error("No follows here")),
    files: pageFiles(screen.channel, downloads),
  });
  return { client, downloads };
};

/** A builder's App, open in their screen, with its client and API. */
const openedApp = async () => {
  const builder = await personApi("builder");
  const { app, release, admin, artifacts } = await releasedApp(builder);
  const screen = await screenOf(builder, app);
  return {
    builder,
    app,
    release,
    admin,
    artifacts,
    api: apiOf(release),
    screen,
    ...clientOf(screen, app),
  };
};

/** A colleague `builder` shared `app` with, its screen open. */
const colleagueOf = async (builder: Person, app: string) => {
  const colleague = await personApi("user");
  await builder.api.apps.members.add(app, {
    type: "person",
    id: colleague.userId,
    role: "user",
  });
  const screen = await screenOf(colleague, app);
  return { userId: colleague.userId, screen, ...clientOf(screen, app) };
};

/** A PNG's bytes: its signature, then `size` bytes in all. */
const png = (size = 64): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let at = 8; at < size; at += 1) {
    bytes[at] = at % 251;
  }
  return bytes;
};

const blobOf = (bytes: Uint8Array<ArrayBuffer>, type: string): Blob =>
  new Blob([bytes], { type });

const never = new AbortController().signal;

/** Uploads `blob` through `channel`, reporting nothing. */
const upload = async (
  channel: FileChannel,
  blob: Blob,
  name = "photo.png",
  resource = "attachments"
): Promise<string> =>
  await channel.upload(resource, blob, name, {
    cancel: never,
    onProgress: () => {
      // Nothing to show.
    },
  });

/** Why `promise` rejected: its code. */
const codeOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GraspError) {
      return error.code;
    }
    return typeof error === "object" && error !== null && "code" in error
      ? error.code
      : error;
  }
  throw new Error("It resolved");
};

/** Runs `work` on the file host of `release`'s store. */
const onStore = async (
  release: Release,
  work: (host: StoreHost, storeId: StoreId) => Promise<void> | void
): Promise<void> => {
  const storeId = storeIdSchema.parse(release.store?.storeId);
  await runInDurableObject(
    env.DATA_STORES.getByName(storeId),
    async (_instance, state) => {
      await work(new StoreHost(state, env), storeId);
    }
  );
};

/** The store's alarm on its files, as at `inMs` from now. */
const sweepIn = async (release: Release, inMs: number): Promise<void> => {
  await onStore(release, async (host, storeId) => {
    await host.files.sweep(storeId, Date.now() + inMs);
  });
};

/** The keys of the R2 objects of `release`'s store's files. */
const storedObjects = async (release: Release): Promise<string[]> => {
  const listed = await env.FILES.list({
    prefix: `app-files/${release.store?.storeId ?? ""}/`,
  });
  return listed.objects.map(({ key }) => key);
};

/** A response's status, once it answered. */
const statusOf = async (answered: Promise<Response>): Promise<number> => {
  const response = await answered;
  await response.body?.cancel();
  return response.status;
};

/** `text` as UTF-8 bytes. */
const utf8 = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new TextEncoder().encode(text));

/**
 * The audit events about files in core's audit outbox, each as its action,
 * then who did it (a person's ID, or `system` and how), oldest first.
 */
/** How many gaps the audit log recorded: a conflicting event makes one. */
const gaps = async (): Promise<number> => {
  const logged = await allEvents();
  return logged.filter(({ action }) => action === "audit.gap").length;
};

const fileEvents = async (): Promise<
  { file: string; said: string; uploadedBy: string }[]
> => {
  const logged = await allEvents();
  return logged.flatMap((read) => {
    if (!read.action.startsWith("file.") || read.target === undefined) {
      return [];
    }
    const who =
      read.actor.type === "person"
        ? read.actor.userId
        : `${read.actor.type}:${String(read.detail.how)}`;
    return [
      {
        file: read.target.id,
        said: `${read.action}:${who}`,
        uploadedBy: String(read.detail.uploadedBy),
      },
    ];
  });
};

/** What `work` refused with, its code, or "admitted" when it didn't. */
const refusal = (work: () => void): unknown => {
  try {
    work();
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      ? error.code
      : error;
  }
  return "admitted";
};

/** The lower-case hex SHA-256 of `bytes`. */
const sha256 = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");

/** A JSON answer's `code`, or its `file` when it has none. */
const answerOf = async (response: Response): Promise<unknown> => {
  const body: unknown = await response.json();
  return typeof body === "object" && body !== null && "code" in body
    ? body.code
    : body;
};

/**
 * Raw requests of `screen`'s file channel for `app`'s `attachments`, as
 * a page that doesn't follow the protocol would send them.
 */
const rawChannel = (screen: Screen, app: string) => {
  const base = `${appFilesPath}/${app}/attachments/uploads`;
  const leased = { [screenLeaseHeader]: screen.lease };
  return {
    begin: async (body: unknown) =>
      await screen.fetch(base, {
        method: "POST",
        headers: { ...leased, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    put: async (
      file: string,
      index: number,
      bytes: Uint8Array<ArrayBuffer>,
      hash: string,
      coreEnv?: Env
    ) =>
      await screen.fetch(
        `${base}/${file}/chunks/${index}`,
        {
          method: "PUT",
          headers: {
            ...leased,
            "content-type": "application/octet-stream",
            [fileChunkHashHeader]: hash,
          },
          body: bytes,
        },
        coreEnv
      ),
    status: async (file: string) =>
      await screen.fetch(`${base}/${file}`, { headers: leased }),
    finish: async (file: string, coreEnv?: Env) =>
      await screen.fetch(
        `${base}/${file}/finish`,
        { method: "POST", headers: leased },
        coreEnv
      ),
  };
};

/**
 * R2 as core sees it, but that each read of an object counts in `reads`
 * and waits for `open` to resolve first.
 */
const gatedReads = (open: Promise<null>) => {
  const seen = { reads: 0 };
  const reading = new Proxy(env.FILES, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      if (property === "get") {
        return async (...args: unknown[]) => {
          seen.reads += 1;
          await open;
          const read: unknown = await Reflect.apply(value, target, args);
          return read;
        };
      }
      const bound: unknown = value.bind(target);
      return bound;
    },
  });
  return { seen, reading };
};

/** R2 as core sees it, but that every deletion fails. */
const failingDeletes = new Proxy(env.FILES, {
  get: (target, property) => {
    if (property === "delete") {
      return async () => {
        await Promise.resolve();
        throw new Error("R2 is unavailable.");
      };
    }
    const value: unknown = Reflect.get(target, property);
    if (typeof value !== "function") {
      return value;
    }
    const bound: unknown = value.bind(target);
    return bound;
  },
});

/**
 * `stub` of a store, but that the answer of `chunkStored` never arrives:
 * the store records the chunk, and its caller hears the connection reset.
 */
const lossyChunkAnswers = (stub: object): object =>
  new Proxy(stub, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      if (property === "chunkStored") {
        return async (...args: unknown[]) => {
          await Reflect.apply(value, target, args);
          throw new Error("The connection was reset.");
        };
      }
      // A stub's methods are called on it, never bound (`bind` is remote).
      return async (...args: unknown[]) => {
        const answer: unknown = await Reflect.apply(value, target, args);
        return answer;
      };
    },
  });

/** Whether a request asks core which chunks an upload holds. */
const asksHeld = (path: string, init: RequestInit) =>
  /\/uploads\/[^/]+$/u.test(path) && (init.method ?? "GET") === "GET";

/**
 * A request that never answers, until its signal stops it, as a
 * browser's over a network gone quiet: rejected then as the browser would.
 */
const neverAnswered = async (init: RequestInit): Promise<Response> => {
  const { promise, reject } = Promise.withResolvers<Response>();
  const { signal } = init;
  if (signal !== undefined && signal !== null) {
    const stop = () => {
      reject(signal.reason);
    };
    if (signal.aborted) {
      stop();
    }
    signal.addEventListener("abort", stop, { once: true });
  }
  return await promise;
};

/**
 * `response` as it arrives over a connection that drops a few bytes into
 * its body, after its headers.
 */
const brokenPartway = (response: Response): Response => {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
    response.body?.getReader();
  const body = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const read = await reader?.read();
      if (read?.value !== undefined) {
        controller.enqueue(read.value.slice(0, 3));
      }
      controller.error(new TypeError("The connection was reset."));
      await reader?.cancel();
    },
  });
  return new Response(body, {
    status: response.status,
    headers: response.headers,
  });
};

/** The state and how each of `release`'s store's files ended, if it did. */
const fileStates = async (release: Release): Promise<string[]> => {
  let states: string[] = [];
  await onStore(release, (host) => {
    states = host.ctx.storage.sql
      .exec<{ state: string }>(
        "SELECT state || ':' || coalesce(deleted_how, '') AS state FROM sdk_files"
      )
      .toArray()
      .map(({ state }) => state);
  });
  return states;
};

/** The ID of the upload a start answered. */
const begunFile = async (response: Response): Promise<string> => {
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("file" in body) ||
    typeof body.file !== "string"
  ) {
    throw new Error("Not an upload's start");
  }
  return body.file;
};

/** A fresh upload key, as a page makes one for each upload. */
const uploadKey = (): string => crypto.randomUUID().replaceAll("-", "");

/** An upload's start, as a page declares it, under a key of its own. */
const declaration = () => ({
  name: "photo.png",
  type: "image/png",
  size: fileLimits.chunkBytes + 10,
  sha256: "0".repeat(64),
  key: uploadKey(),
});

/** Which of an upload's last two requests `path` is, if either. */
const lastStepOf = (path: string, init: RequestInit) => {
  if (path.endsWith("/finish")) {
    return "finish";
  }
  return init.method === "DELETE" ? "cancel" : "other";
};

/**
 * `screen`'s file channel for `app`, over a network that delivers an
 * upload's finish and its cancellation in the order `first` says: the
 * other waits until `first` was answered (or, should `first` never be
 * sent, a few seconds).
 */
const orderedChannel = (
  screen: Screen,
  app: string,
  first: "finish" | "cancel"
): FileChannel => {
  const { promise: answered, resolve } = Promise.withResolvers<null>();
  const fallback = setTimeout(() => {
    resolve(null);
  }, 5000);
  return fileChannel({
    app,
    lease: screen.lease,
    person: screen.named,
    fetch: async (path, init) => {
      const which = lastStepOf(path, init);
      if (which !== "other" && which !== first) {
        await answered;
      }
      const response = await screen.fetch(path, init);
      if (which === first) {
        clearTimeout(fallback);
        resolve(null);
      }
      return response;
    },
  });
};

describe("an App's files", { timeout: 120_000 }, () => {
  it("uploads a file in chunks, reporting the bytes core holds", async () => {
    const { screen } = await openedApp();
    const progress: unknown[] = [];
    const bytes = png(fileLimits.chunkBytes + 100);
    const id = await screen.channel.upload(
      "attachments",
      blobOf(bytes, "image/png"),
      "Plan.png",
      {
        cancel: never,
        onProgress: (step) => {
          progress.push(step);
        },
      }
    );
    expect(progress).toStrictEqual([
      { phase: "uploading", bytesUploaded: 0, bytesTotal: bytes.length },
      {
        phase: "uploading",
        bytesUploaded: fileLimits.chunkBytes,
        bytesTotal: bytes.length,
      },
      {
        phase: "verifying",
        bytesUploaded: bytes.length,
        bytesTotal: bytes.length,
      },
    ]);
    await expect(
      screen.channel.describe("attachments", id)
    ).resolves.toStrictEqual({
      id,
      name: "Plan.png",
      mimeType: "image/png",
      size: bytes.length,
    });
  });

  it("attaches a file to a note under its revision, and downloads it only as an attachment", async () => {
    const { client, api, screen, downloads } = await openedApp();
    const id = await upload(screen.channel, blobOf(png(), "image/png"));
    const note = await client.mutation(api.create, { title: "Plan" });
    await expect(
      client.mutation(api.attachFile, {
        id: note,
        expectedRevision: 1,
        file: { id },
      })
    ).resolves.toMatchObject({ _rev: 2, attachments: [{ id }] });
    // A stale revision is a conflict, the attachment as it was.
    await expect(
      codeOf(
        client.mutation(api.detachFile, {
          id: note,
          expectedRevision: 1,
          file: { id },
        })
      )
    ).resolves.toBe("data.conflict");
    await client.files.download(resources.attachments, { id });
    expect(downloads.get(id)).toStrictEqual(png());
    const response = await screen.channel.content("attachments", id);
    await response.body?.cancel();
    expect({
      disposition: response.headers.get("content-disposition"),
      sniffing: response.headers.get("x-content-type-options"),
      cache: response.headers.get("cache-control"),
    }).toStrictEqual({
      disposition: `attachment; filename="photo.png"; filename*=UTF-8''photo.png`,
      sniffing: "nosniff",
      cache: "private, no-store",
    });
  });

  it("keeps an unattached upload its uploader's alone, whatever another person asks", async () => {
    const { builder, app, api, screen } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const id = await upload(screen.channel, blobOf(png(), "image/png"));
    const theirNote = await colleague.client.mutation(api.create, {
      title: "Theirs",
    });
    // The same answer for their upload as for an ID that doesn't exist.
    await expect(
      Promise.all([
        codeOf(colleague.screen.channel.describe("attachments", id)),
        codeOf(
          colleague.screen.channel.describe("attachments", crypto.randomUUID())
        ),
        codeOf(colleague.screen.channel.delete("attachments", id)),
        codeOf(
          colleague.client.mutation(api.attachFile, {
            id: theirNote,
            expectedRevision: 1,
            file: { id },
          })
        ),
      ])
    ).resolves.toStrictEqual([
      "file.not_found",
      "file.not_found",
      "file.not_found",
      "file.not_found",
    ]);
  });

  it("lets another person read a file while a note they may read holds it, and never delete it", async () => {
    const { builder, app, client, api, screen } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const id = await upload(screen.channel, blobOf(png(), "image/png"));
    const note = await client.mutation(api.create, { title: "Shared" });
    await client.mutation(api.attachFile, {
      id: note,
      expectedRevision: 1,
      file: { id },
    });
    await colleague.client.files.download(resources.attachments, { id });
    expect(colleague.downloads.get(id)).toStrictEqual(png());
    await expect(
      codeOf(colleague.screen.channel.delete("attachments", id))
    ).resolves.toBe("file.not_found");
    // Detached again: theirs to read no longer.
    await client.mutation(api.detachFile, {
      id: note,
      expectedRevision: 2,
      file: { id },
    });
    await expect(
      codeOf(colleague.screen.channel.describe("attachments", id))
    ).resolves.toBe("file.not_found");
  });

  it("keeps each App's files to it, and each use to the operations its resource declares", async () => {
    const one = await openedApp();
    const other = await openedApp();
    const id = await upload(other.screen.channel, blobOf(png(), "image/png"));
    const note = await one.client.mutation(one.api.create, { title: "One" });
    await expect(
      Promise.all([
        codeOf(
          one.client.mutation(one.api.attachFile, {
            id: note,
            expectedRevision: 1,
            file: { id },
          })
        ),
        codeOf(one.screen.channel.describe("attachments", id)),
        // `photos` declares only `read`, `nothing` nothing at all.
        codeOf(
          upload(
            one.screen.channel,
            blobOf(png(), "image/png"),
            "a.png",
            "photos"
          )
        ),
        codeOf(one.screen.channel.describe("nothing", id)),
      ])
    ).resolves.toStrictEqual([
      "file.not_found",
      "file.not_found",
      "file.operation_denied",
      "file.operation_denied",
    ]);
  });

  it("refuses a request without the screen's lease, or from another site", async () => {
    const { app, builder } = await openedApp();
    const { lease } = await builder.api.screens.open(app, "notes");
    const path = `${appFilesPath}/${app}/attachments/files/${crypto.randomUUID()}`;
    const statuses = await Promise.all(
      [
        new Headers({ cookie: builder.session }),
        new Headers({
          cookie: builder.session,
          [screenLeaseHeader]: lease,
          "sec-fetch-site": "cross-site",
        }),
      ].map(async (headers) => await statusOf(routed(path, { headers })))
    );
    expect(statuses).toStrictEqual([403, 403]);
  });

  it("refuses a change from no Origin or another site's, though its lease and session are the screen's", async () => {
    const { builder, app, screen } = await openedApp();
    const id = await upload(screen.channel, blobOf(png(), "image/png"));
    const base = `${appFilesPath}/${app}/attachments`;
    const sent = async (path: string, body: unknown, origin?: string) => {
      const headers = new Headers({
        cookie: builder.session,
        [screenLeaseHeader]: screen.lease,
        [screenPersonHeader]: builder.userId,
        "content-type": "application/json",
      });
      if (origin !== undefined) {
        headers.set("origin", origin);
      }
      return await statusOf(
        routed(path, { method: "POST", headers, body: JSON.stringify(body) })
      );
    };
    const start = `${base}/uploads`;
    const deletion = `${base}/files/${id}/delete`;
    const starting = { ...declaration(), size: 100 };
    const deleting = { idempotencyKey: uploadKey() };
    expect([
      await sent(start, starting),
      await sent(start, starting, "https://elsewhere.example"),
      await sent(deletion, deleting),
      await sent(deletion, deleting, "https://elsewhere.example"),
    ]).toStrictEqual([403, 403, 403, 403]);
    // The file is still there: nothing of either reached the store.
    await expect(
      screen.channel.describe("attachments", id)
    ).resolves.toMatchObject({ id });
  });

  it("refuses a screen's file requests once its build is unreviewed, or revoked", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const { id: app } = await builder.api.apps.create({ name: "Notes" });
    const { version } = await builder.api.apps.files.commit(
      app,
      files,
      "First"
    );
    await builder.api.apps.versions.setCurrent(app, version);
    // Its data ordinary: a screen nobody approved runs, and gets a lease.
    const first = await admin.api.screenTrust.review(app);
    await admin.api.screenTrust.classify(app, "ordinary", first.generation);
    const screen = await screenOf(builder, app);
    const id = await upload(screen.channel, blobOf(png(), "image/png"));
    const refusals = async () => [
      await codeOf(screen.channel.describe("attachments", id)),
      await codeOf(upload(screen.channel, blobOf(png(), "image/png"))),
    ];
    // Sensitive again: the build nobody approved gets none of it.
    const second = await admin.api.screenTrust.review(app);
    await admin.api.screenTrust.classify(app, "sensitive", second.generation);
    const unreviewed = await refusals();
    // Approved, then revoked.
    const third = await admin.api.screenTrust.review(app);
    const artifacts = builtArtifacts(third.screens);
    await admin.api.screenTrust.approve(app, {
      version: third.version,
      generation: third.generation,
      artifacts,
    });
    for (const artifact of artifacts) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await admin.api.screenTrust.revoke(app, artifact);
    }
    expect({ unreviewed, revoked: await refusals() }).toStrictEqual({
      unreviewed: ["screen.unreviewed", "screen.unreviewed"],
      revoked: ["screen.revoked", "screen.revoked"],
    });
  });

  it("refuses a request whose lease doesn't verify for its person, though the App's data is ordinary", async () => {
    const { builder, app, screen } = await openedApp();
    const id = await upload(screen.channel, blobOf(png(), "image/png"));
    // Ordinary data: a screen of it runs without a valid lease elsewhere.
    const admin = await personApi("admin");
    const { generation } = await admin.api.screenTrust.review(app);
    await admin.api.screenTrust.classify(app, "ordinary", generation);
    const colleague = await colleagueOf(builder, app);
    const described = async (lease: string) =>
      await screen.fetch(`${appFilesPath}/${app}/attachments/files/${id}`, {
        headers: { [screenLeaseHeader]: lease },
      });
    const refused = await Promise.all(
      // Forged; then a real lease, but signed for someone else.
      [`${"0".repeat(64)}.${"A".repeat(43)}`, colleague.screen.lease].map(
        async (lease) => {
          const response = await described(lease);
          return [response.status, await answerOf(response)];
        }
      )
    );
    expect(refused).toStrictEqual([
      [403, "request.forbidden"],
      [403, "request.forbidden"],
    ]);
    await expect(statusOf(described(screen.lease))).resolves.toBe(200);
  });

  it("refuses a request naming someone other than the person signed in, or nobody, before it starts anything", async () => {
    const { builder, app, release, screen } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const begin = async (named?: string) =>
      await routed(`${appFilesPath}/${app}/attachments/uploads`, {
        method: "POST",
        headers: {
          origin: clientOrigin,
          cookie: builder.session,
          "content-type": "application/json",
          [screenLeaseHeader]: screen.lease,
          ...(named === undefined ? {} : { [screenPersonHeader]: named }),
        },
        body: JSON.stringify(declaration()),
      });
    const refused = await Promise.all(
      [colleague.userId, undefined].map(async (named) => {
        const response = await begin(named);
        return [response.status, await answerOf(response)];
      })
    );
    expect(refused).toStrictEqual([
      [401, "auth.principal_changed"],
      [403, "screen.reload_required"],
    ]);
    // A channel whose frame is someone else's starts nothing either.
    const theirs = fileChannel({
      app,
      lease: screen.lease,
      person: colleague.screen.named,
      fetch: screen.fetch,
    });
    await expect(
      codeOf(upload(theirs, blobOf(png(), "image/png")))
    ).resolves.toBe("auth.principal_changed");
    await expect(fileStates(release)).resolves.toStrictEqual([]);
  });

  it("refuses an upload past its limits, or of a type a browser runs, before any byte", async () => {
    const { app, screen } = await openedApp();
    const raw = rawChannel(screen, app);
    const refused = await Promise.all(
      [
        { ...declaration(), size: fileLimits.bytes + 1 },
        { ...declaration(), type: "image/svg+xml" },
        { ...declaration(), type: "text/html" },
        { ...declaration(), name: "../photo.png" },
        // Half a surrogate pair: no character, so no name a header encodes.
        { ...declaration(), name: `photo${String.fromCodePoint(0xd8_00)}.png` },
        { ...declaration(), extra: true },
      ].map(async (body) => {
        const response = await raw.begin(body);
        return [response.status, await answerOf(response)];
      })
    );
    expect(refused).toStrictEqual(
      Array.from({ length: 6 }, () => [422, "file.invalid"])
    );
    // The page refuses such a file before asking core at all.
    await expect(
      codeOf(upload(screen.channel, blobOf(png(), "image/svg+xml"), "a.svg"))
    ).resolves.toBe("file.type_unsupported");
  });

  it("keeps a chunk only if it is the one its place and hash say", async () => {
    const { app, screen } = await openedApp();
    const raw = rawChannel(screen, app);
    const file = await begunFile(await raw.begin(declaration()));
    const first = png(fileLimits.chunkBytes);
    const short = first.slice(0, 100);
    const statuses = [
      await statusOf(raw.put(file, 0, first, "0".repeat(64))),
      await statusOf(raw.put(file, 0, short, await sha256(short))),
      await statusOf(raw.put(file, 2, short, await sha256(short))),
    ];
    expect(statuses).toStrictEqual([422, 422, 422]);
    await expect(answerOf(await raw.status(file))).resolves.toMatchObject({
      state: "uploading",
      received: [],
    });
    // A finish before every chunk arrived publishes nothing.
    await expect(answerOf(await raw.finish(file))).resolves.toBe(
      "file.incomplete"
    );
  });

  it("refuses other bytes sent for a chunk it holds, though of the same size", async () => {
    const { app, screen } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    const other = png(100).fill(7, 8);
    const statuses = [
      await statusOf(raw.put(file, 0, bytes, sha)),
      await statusOf(raw.put(file, 0, other, await sha256(other))),
      await statusOf(raw.put(file, 0, bytes, sha)),
    ];
    expect(statuses).toStrictEqual([200, 422, 200]);
  });

  it("rejects a whole that isn't the file declared, and lets the uploader start another", async () => {
    const { app, screen } = await openedApp();
    const raw = rawChannel(screen, app);
    const file = await begunFile(await raw.begin(declaration()));
    const first = png(fileLimits.chunkBytes);
    const last = first.slice(0, 10);
    await raw.put(file, 0, first, await sha256(first));
    await raw.put(file, 1, last, await sha256(last));
    await expect(answerOf(await raw.finish(file))).resolves.toBe(
      "file.content_mismatch"
    );
    // The rejected upload is no longer open: they may open as many again.
    const opened = await Promise.all(
      Array.from(
        { length: fileLimits.openUploads },
        async () => await statusOf(raw.begin(declaration()))
      )
    );
    expect(opened.every((status) => status === 200)).toBeTruthy();
    await expect(answerOf(await raw.begin(declaration()))).resolves.toBe(
      "file.uploads_open"
    );
  });

  it("checks a file's bytes against its type when it is finished", async () => {
    const { screen } = await openedApp();
    const text = async (content: Uint8Array<ArrayBuffer>) =>
      await upload(screen.channel, blobOf(content, "text/plain"), "notes.txt");
    await expect(
      Promise.all([
        codeOf(upload(screen.channel, blobOf(utf8("not a png"), "image/png"))),
        // Text that isn't UTF-8, or holds a NUL, isn't text.
        codeOf(text(new Uint8Array([0x68, 0x69, 0xff, 0xfe]))),
        codeOf(text(new Uint8Array([0x68, 0x00, 0x69]))),
        // Nor a PNG declared as text.
        codeOf(text(png())),
      ])
    ).resolves.toStrictEqual(
      Array.from({ length: 4 }, () => "file.content_mismatch")
    );
    await expect(text(utf8("Hello, café"))).resolves.toMatch(
      /^[0-9a-f-]{36}$/u
    );
  });

  it("resumes an upload whose answers were lost under the same upload, never a fresh one", async () => {
    const builder = await personApi("builder");
    const { app, release } = await releasedApp(builder);
    const screen = await screenOf(builder, app);
    // The network loses the answers to the start, the second chunk and
    // the first finish: all three reached core.
    const sent = { begins: 0, chunks: 0, finishes: 0 };
    const lossy = async (path: string, init: RequestInit) => {
      const response = await screen.fetch(path, init);
      if (path.endsWith("/uploads")) {
        sent.begins += 1;
      }
      if (path.includes("/chunks/")) {
        sent.chunks += 1;
      }
      if (path.endsWith("/finish")) {
        sent.finishes += 1;
      }
      if (
        (path.endsWith("/uploads") && sent.begins === 1) ||
        (path.includes("/chunks/") && sent.chunks === 2) ||
        (path.endsWith("/finish") && sent.finishes === 1)
      ) {
        throw new TypeError("The connection was reset.");
      }
      return response;
    };
    const channel = fileChannel({
      app,
      lease: screen.lease,
      person: screen.named,
      fetch: lossy,
    });
    const bytes = png(2 * fileLimits.chunkBytes + 5);
    const id = await upload(channel, blobOf(bytes, "image/png"));
    // Each chunk sent once: core said it held the one whose answer was lost.
    expect(sent).toStrictEqual({ begins: 2, chunks: 3, finishes: 2 });
    await expect(
      screen.channel.describe("attachments", id)
    ).resolves.toMatchObject({ size: bytes.length });
    // One upload, its three chunks, nothing else: the start sent again
    // under its key was the same upload.
    await expect(storedObjects(release)).resolves.toHaveLength(3);
    let uploads = 0;
    await onStore(release, (host) => {
      uploads = host.ctx.storage.sql
        .exec("SELECT file_id FROM sdk_files")
        .toArray().length;
    });
    expect(uploads).toBe(1);
    // A key is one upload's: another declaration under it is a conflict.
    const raw = rawChannel(screen, app);
    const declared = declaration();
    const first = await begunFile(await raw.begin(declared));
    const again = await begunFile(await raw.begin(declared));
    const other = await answerOf(
      await raw.begin({ ...declared, name: "other.png" })
    );
    expect([again, other]).toStrictEqual([first, "submission.key_conflict"]);
  });

  it("goes on past answers lost on one chunk after another, each recovered", async () => {
    const { app, screen } = await openedApp();
    // The answer to every chunk but the first is lost, once each.
    const lostOnce = new Set<string>();
    const lossy = async (path: string, init: RequestInit) => {
      const response = await screen.fetch(path, init);
      const chunk = /\/chunks\/(?<index>\d+)$/u.exec(path)?.groups?.index;
      if (chunk !== undefined && chunk !== "0" && !lostOnce.has(chunk)) {
        lostOnce.add(chunk);
        await response.body?.cancel();
        throw new TypeError("The connection was reset.");
      }
      return response;
    };
    const channel = fileChannel({
      app,
      lease: screen.lease,
      person: screen.named,
      fetch: lossy,
    });
    const bytes = png(6 * fileLimits.chunkBytes);
    const id = await upload(channel, blobOf(bytes, "image/png"));
    expect(lostOnce.size).toBe(5);
    await expect(
      screen.channel.describe("attachments", id)
    ).resolves.toMatchObject({ size: bytes.length });
  });

  it("recovers an answer whose body broke partway under the same upload", async () => {
    const { app, release, screen } = await openedApp();
    // The connection drops after the headers of the first start's and the
    // first finish's answers, a few bytes into their bodies.
    const broken = new Set<string>();
    const channel = fileChannel({
      app,
      lease: screen.lease,
      person: screen.named,
      fetch: async (path, init) => {
        const response = await screen.fetch(path, init);
        const step = path.endsWith("/finish") ? "finish" : path;
        if (
          (path.endsWith("/uploads") || path.endsWith("/finish")) &&
          !broken.has(step)
        ) {
          broken.add(step);
          return brokenPartway(response);
        }
        return response;
      },
    });
    const bytes = png(fileLimits.chunkBytes + 5);
    const id = await upload(channel, blobOf(bytes, "image/png"));
    expect(broken.size).toBe(2);
    await expect(
      screen.channel.describe("attachments", id)
    ).resolves.toMatchObject({ size: bytes.length });
    await expect(fileStates(release)).resolves.toStrictEqual(["published:"]);
  });

  it("answers a cancellation with what won: cancelled, or the file when publication came first", async () => {
    const { app, client, api, release, screen } = await openedApp();
    const early = new AbortController();
    const cancelled = screen.channel.upload(
      "attachments",
      blobOf(png(3 * fileLimits.chunkBytes), "image/png"),
      "big.png",
      {
        cancel: early.signal,
        onProgress: ({ bytesUploaded }) => {
          if (bytesUploaded > 0) {
            early.abort();
          }
        },
      }
    );
    await expect(codeOf(cancelled)).resolves.toBe("file.cancelled");
    // Cancelled while its finish is under way, the finish reaching core
    // first: the file, which its uploader has.
    const late = new AbortController();
    const id = await orderedChannel(screen, app, "finish").upload(
      "attachments",
      blobOf(png(), "image/png"),
      "small.png",
      {
        cancel: late.signal,
        onProgress: ({ phase }) => {
          if (phase === "verifying") {
            late.abort();
          }
        },
      }
    );
    const note = await client.mutation(api.create, { title: "Kept" });
    await expect(
      client.mutation(api.attachFile, {
        id: note,
        expectedRevision: 1,
        file: { id },
      })
    ).resolves.toMatchObject({ attachments: [{ id }] });
    // The cancelled upload's chunk goes once its grace passed.
    await sweepIn(release, purgeGraceMs + 1);
    const kept = await storedObjects(release);
    expect(kept).toHaveLength(1);
    expect(
      kept[0]?.startsWith(`app-files/${release.store?.storeId ?? ""}/${id}/0.`)
    ).toBeTruthy();
  });

  it("lets a cancellation sent while its upload is verified win, the file never readable", async () => {
    const { app, release, screen } = await openedApp();
    const cancel = new AbortController();
    const finishing = orderedChannel(screen, app, "cancel").upload(
      "attachments",
      blobOf(png(), "image/png"),
      "late.png",
      {
        cancel: cancel.signal,
        onProgress: ({ phase }) => {
          if (phase === "verifying") {
            cancel.abort();
          }
        },
      }
    );
    await expect(codeOf(finishing)).resolves.toBe("file.cancelled");
    await expect(fileStates(release)).resolves.toStrictEqual([
      "deleted:cancelled",
    ]);
  });

  it("answers a mutation sent again under its key as it did, though the file it detached is no longer the caller's to read", async () => {
    const { builder, app, client, api, screen } = await openedApp();
    const id = await upload(screen.channel, blobOf(png(), "image/png"));
    const pinned = await client.mutation(api.pin, { file: { id } });
    const colleague = await colleagueOf(builder, app);
    const unpin = async () =>
      await colleague.client.mutation(
        api.unpin,
        { id: pinned, expectedRevision: 1, file: { id } },
        { idempotencyKey: "unpin-once" }
      );
    // Its answer lost, the colleague sends it again under the same key.
    await expect(unpin()).resolves.toBeNull();
    await expect(unpin()).resolves.toBeNull();
    // A fresh call is a new execution, its files checked again.
    await expect(
      codeOf(
        colleague.client.mutation(api.unpin, {
          id: pinned,
          expectedRevision: 2,
          file: { id },
        })
      )
    ).resolves.toBe("file.not_found");
  });

  it("settles a cancellation on core's answer, though the finish never answers", async () => {
    const { app, release, screen } = await openedApp();
    const { promise: stalled, resolve: unstall } =
      Promise.withResolvers<null>();
    const channel = fileChannel({
      app,
      lease: screen.lease,
      person: screen.named,
      fetch: async (path, init) => {
        if (path.endsWith("/finish")) {
          await stalled;
        }
        return await screen.fetch(path, init);
      },
    });
    const cancel = new AbortController();
    const { promise: late, resolve: giveUp } = Promise.withResolvers<string>();
    const timer = setTimeout(() => {
      giveUp("still waiting on the finish");
    }, 5000);
    try {
      const finishing = codeOf(
        channel.upload("attachments", blobOf(png(), "image/png"), "slow.png", {
          cancel: cancel.signal,
          onProgress: ({ phase }) => {
            if (phase === "verifying") {
              cancel.abort();
            }
          },
        })
      );
      await expect(Promise.race([finishing, late])).resolves.toBe(
        "file.cancelled"
      );
    } finally {
      clearTimeout(timer);
      unstall(null);
    }
    await expect(fileStates(release)).resolves.toStrictEqual([
      "deleted:cancelled",
    ]);
  });

  it("keeps a key one file's, a deletion of a file already deleted keeping it too", async () => {
    const { client, screen } = await openedApp();
    const first = await upload(screen.channel, blobOf(png(), "image/png"));
    const second = await upload(screen.channel, blobOf(png(32), "image/png"));
    await client.files.delete(resources.attachments, { id: first });
    const keyed = { idempotencyKey: "tidy-up" };
    // Deleted already: the deletion under the key answers as it did.
    await client.files.delete(resources.attachments, { id: first }, keyed);
    await expect(
      Promise.all([
        codeOf(
          client.files.delete(resources.attachments, { id: second }, keyed)
        ),
        client.files.delete(resources.attachments, { id: first }, keyed),
      ])
    ).resolves.toStrictEqual(["submission.key_conflict", undefined]);
  });

  it("cancels at once while a chunk's request is stalled, and sends a chunk stalled too long again", async () => {
    const { app, release, screen } = await openedApp();
    const cancel = new AbortController();
    const quiet = fileChannel({
      app,
      lease: screen.lease,
      person: screen.named,
      fetch: async (path, init) =>
        path.includes("/chunks/")
          ? await neverAnswered(init)
          : await screen.fetch(path, init),
    });
    const { promise: late, resolve: giveUp } = Promise.withResolvers<string>();
    const timer = setTimeout(() => {
      giveUp("still waiting on the chunk");
    }, 5000);
    try {
      const cancelling = codeOf(
        quiet.upload("attachments", blobOf(png(), "image/png"), "slow.png", {
          cancel: cancel.signal,
          onProgress: ({ phase }) => {
            if (phase === "uploading") {
              cancel.abort();
            }
          },
        })
      );
      await expect(Promise.race([cancelling, late])).resolves.toBe(
        "file.cancelled"
      );
    } finally {
      clearTimeout(timer);
    }
    await expect(fileStates(release)).resolves.toStrictEqual([
      "deleted:cancelled",
    ]);
    // The first request of the second chunk stalls; given up on, it is
    // sent again, and the upload publishes.
    let stalls = 0;
    const flaky = fileChannel({
      app,
      lease: screen.lease,
      person: screen.named,
      chunkMs: 300,
      fetch: async (path, init) => {
        if (path.endsWith("/chunks/1") && stalls === 0) {
          stalls += 1;
          return await neverAnswered(init);
        }
        return await screen.fetch(path, init);
      },
    });
    const bytes = png(fileLimits.chunkBytes + 5);
    const id = await upload(flaky, blobOf(bytes, "image/png"));
    await expect(
      screen.channel.describe("attachments", id)
    ).resolves.toMatchObject({ size: bytes.length });
  });

  it("cancels at once while its start is stalled, cancelling the upload the start made under its key", async () => {
    const { app, release, screen } = await openedApp();
    const cancel = new AbortController();
    let starts = 0;
    const channel = fileChannel({
      app,
      lease: screen.lease,
      person: screen.named,
      fetch: async (path, init) => {
        if (path.endsWith("/uploads")) {
          starts += 1;
          if (starts === 1) {
            // It reaches core, which makes the upload; its answer never comes.
            await screen.fetch(path, init);
            cancel.abort();
            return await neverAnswered(init);
          }
        }
        return await screen.fetch(path, init);
      },
    });
    const { promise: late, resolve: giveUp } = Promise.withResolvers<string>();
    const timer = setTimeout(() => {
      giveUp("still waiting on the start");
    }, 5000);
    try {
      const cancelling = codeOf(
        channel.upload("attachments", blobOf(png(), "image/png"), "slow.png", {
          cancel: cancel.signal,
          onProgress: () => {
            // Cancelled from the stalled start, not from here.
          },
        })
      );
      await expect(Promise.race([cancelling, late])).resolves.toBe(
        "file.cancelled"
      );
    } finally {
      clearTimeout(timer);
    }
    // One upload, the one the stalled start made, found again and cancelled.
    await expect(fileStates(release)).resolves.toStrictEqual([
      "deleted:cancelled",
    ]);
  });

  it("answers a cancellation during its start as cancelled only once core says so", async () => {
    const { app, release, screen } = await openedApp();
    const cancel = new AbortController();
    let starts = 0;
    const channel = fileChannel({
      app,
      lease: screen.lease,
      person: screen.named,
      fetch: async (path, init) => {
        if (path.endsWith("/uploads")) {
          starts += 1;
          if (starts === 1) {
            // It reaches core, which makes the upload; its answer never comes.
            await screen.fetch(path, init);
            cancel.abort();
            return await neverAnswered(init);
          }
          // Finding it again fails: nothing says it was cancelled.
          throw Object.assign(new Error("Core can't be reached."), {
            code: "internal.unavailable",
          });
        }
        return await screen.fetch(path, init);
      },
    });
    await expect(
      codeOf(
        channel.upload("attachments", blobOf(png(), "image/png"), "lost.png", {
          cancel: cancel.signal,
          onProgress: () => {
            // Cancelled from the stalled start, not from here.
          },
        })
      )
    ).resolves.toBe("internal.unavailable");
    await expect(fileStates(release)).resolves.toStrictEqual(["uploading:"]);
    // Cancelled before any start is sent: nothing began, so it is cancelled.
    let sent = 0;
    const counting = fileChannel({
      app,
      lease: screen.lease,
      person: screen.named,
      fetch: async (path, init) => {
        sent += 1;
        return await screen.fetch(path, init);
      },
    });
    const early = new AbortController();
    early.abort();
    await expect(
      codeOf(
        counting.upload("attachments", blobOf(png(), "image/png"), "no.png", {
          cancel: early.signal,
          onProgress: () => {
            // Nothing to report.
          },
        })
      )
    ).resolves.toBe("file.cancelled");
    expect(sent).toBe(0);
  });

  it("cancels at once while asking core which chunks it holds is stalled, after a lost chunk or a finish that found one missing", async () => {
    const { app, release, screen } = await openedApp();
    const stalledAfter = async (lose: "chunk" | "finish") => {
      const cancel = new AbortController();
      let chunks = 0;
      const channel = fileChannel({
        app,
        lease: screen.lease,
        person: screen.named,
        fetch: async (path, init) => {
          if (asksHeld(path, init)) {
            cancel.abort();
            return await neverAnswered(init);
          }
          if (path.includes("/chunks/")) {
            chunks += 1;
            if (lose === "finish" && chunks === 1) {
              // Answered without reaching core: the finish finds it missing.
              return new Response(null, { status: 204 });
            }
            const response = await screen.fetch(path, init);
            if (lose === "chunk" && chunks === 1) {
              throw new TypeError("The connection was reset.");
            }
            return response;
          }
          return await screen.fetch(path, init);
        },
      });
      const { promise: late, resolve: giveUp } =
        Promise.withResolvers<string>();
      const timer = setTimeout(() => {
        giveUp("still waiting on what core holds");
      }, 5000);
      try {
        return await Promise.race([
          codeOf(
            channel.upload(
              "attachments",
              blobOf(png(), "image/png"),
              `${lose}.png`,
              {
                cancel: cancel.signal,
                onProgress: () => {
                  // Cancelled from the stalled request, not from here.
                },
              }
            )
          ),
          late,
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    await expect(stalledAfter("chunk")).resolves.toBe("file.cancelled");
    await expect(stalledAfter("finish")).resolves.toBe("file.cancelled");
    // Both cancelled under the upload each had begun.
    await expect(fileStates(release)).resolves.toStrictEqual([
      "deleted:cancelled",
      "deleted:cancelled",
    ]);
  });

  it("refuses to delete an upload that isn't finished: its uploader cancels it", async () => {
    const { app, client, release, screen } = await openedApp();
    const file = await begunFile(
      await rawChannel(screen, app).begin(declaration())
    );
    await expect(
      codeOf(client.files.delete(resources.attachments, { id: file }))
    ).resolves.toBe("file.not_found");
    await expect(fileStates(release)).resolves.toStrictEqual(["uploading:"]);
  });

  it("refuses to delete a file a record holds, and deletes its uploader's own under a key", async () => {
    const { client, api, screen } = await openedApp();
    const held = await upload(screen.channel, blobOf(png(), "image/png"));
    const loose = await upload(screen.channel, blobOf(png(32), "image/png"));
    const note = await client.mutation(api.create, { title: "Holder" });
    await client.mutation(api.attachFile, {
      id: note,
      expectedRevision: 1,
      file: { id: held },
    });
    const keyed = { idempotencyKey: "clean-up" };
    await client.files.delete(resources.attachments, { id: loose }, keyed);
    // The same key again answers the same deletion.
    await client.files.delete(resources.attachments, { id: loose }, keyed);
    const other = await client.mutation(api.create, { title: "Late" });
    await expect(
      Promise.all([
        codeOf(client.files.delete(resources.attachments, { id: held })),
        codeOf(client.files.delete(resources.attachments, { id: held }, keyed)),
        codeOf(screen.channel.describe("attachments", loose)),
        codeOf(
          client.mutation(api.attachFile, {
            id: other,
            expectedRevision: 1,
            file: { id: loose },
          })
        ),
      ])
    ).resolves.toStrictEqual([
      "file.referenced",
      "submission.key_conflict",
      "file.not_found",
      "file.not_found",
    ]);
  });

  it("cleans up a file once nothing holds it for the orphan retention, and never one held again", async () => {
    const { client, api, release, screen } = await openedApp();
    const id = await upload(screen.channel, blobOf(png(), "image/png"));
    const note = await client.mutation(api.create, { title: "Holder" });
    await client.mutation(api.attachFile, {
      id: note,
      expectedRevision: 1,
      file: { id },
    });
    // Its note deleted: kept through the orphan retention.
    await client.mutation(api.remove, { id: note, expectedRevision: 2 });
    await sweepIn(release, fileLimits.orphanMs - 60_000);
    await expect(
      screen.channel.describe("attachments", id)
    ).resolves.toMatchObject({ id });
    // Held again before it was cleaned up: the cleanup due is stale.
    const again = await client.mutation(api.create, { title: "Again" });
    await client.mutation(api.attachFile, {
      id: again,
      expectedRevision: 1,
      file: { id },
    });
    await sweepIn(release, fileLimits.orphanMs + purgeGraceMs + 1);
    await expect(
      screen.channel.describe("attachments", id)
    ).resolves.toMatchObject({ id });
    // Detached, and nothing holds it through the retention: deleted, then
    // its bytes removed.
    await client.mutation(api.detachFile, {
      id: again,
      expectedRevision: 2,
      file: { id },
    });
    await sweepIn(release, fileLimits.orphanMs + 1);
    await sweepIn(release, fileLimits.orphanMs + purgeGraceMs + 2);
    await expect(
      codeOf(screen.channel.describe("attachments", id))
    ).resolves.toBe("file.not_found");
    await expect(storedObjects(release)).resolves.toStrictEqual([]);
  });

  it("expires an upload that wasn't finished in time, its start sent again answered so too", async () => {
    const { app, release, screen } = await openedApp();
    const raw = rawChannel(screen, app);
    const declared = declaration();
    const file = await begunFile(await raw.begin(declared));
    // Past its time, before the alarm deleted it.
    vi.useFakeTimers({ toFake: ["Date"] });
    let beforeSweep: unknown;
    try {
      vi.setSystemTime(Date.now() + fileLimits.uploadMs + 1);
      beforeSweep = await answerOf(await raw.begin(declared));
    } finally {
      vi.useRealTimers();
    }
    await sweepIn(release, fileLimits.uploadMs + 1);
    const late = await raw.status(file);
    expect(late.status).toBe(410);
    expect({
      late: await answerOf(late),
      beforeSweep,
      afterSweep: await answerOf(await raw.begin(declared)),
    }).toStrictEqual({
      late: "file.upload_expired",
      beforeSweep: "file.upload_expired",
      afterSweep: "file.upload_expired",
    });
  });

  it("delivers none of a download's remaining bytes once its file is deleted", async () => {
    const { screen } = await openedApp();
    const id = await upload(
      screen.channel,
      blobOf(png(2 * fileLimits.chunkBytes), "image/png")
    );
    const response = await screen.channel.content("attachments", id);
    const reader = response.body?.getReader();
    const first: ReadableStreamReadResult<Uint8Array> | undefined =
      await reader?.read();
    expect(first?.value?.byteLength).toBe(fileLimits.chunkBytes);
    await screen.channel.delete("attachments", id);
    await expect(reader?.read()).rejects.toThrow("That file isn't available.");
  });

  it("delivers none of a download's remaining bytes once its reader may no longer read it", async () => {
    const { builder, app, client, api, screen } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const id = await upload(
      screen.channel,
      blobOf(png(2 * fileLimits.chunkBytes), "image/png")
    );
    const note = await client.mutation(api.create, { title: "Shared" });
    await client.mutation(api.attachFile, {
      id: note,
      expectedRevision: 1,
      file: { id },
    });
    const response = await colleague.screen.channel.content("attachments", id);
    const reader = response.body?.getReader();
    await reader?.read();
    // Detached: the colleague reads it through no record any more.
    await client.mutation(api.detachFile, {
      id: note,
      expectedRevision: 2,
      file: { id },
    });
    await expect(reader?.read()).rejects.toThrow("That file isn't available.");
  });

  it("delivers none of a download's remaining bytes once its reader signed out", async () => {
    const { builder, screen } = await openedApp();
    const id = await upload(
      screen.channel,
      blobOf(png(2 * fileLimits.chunkBytes), "image/png")
    );
    const response = await screen.channel.content("attachments", id);
    const reader = response.body?.getReader();
    await reader?.read();
    await callAuth("/sign-out", builder.session, {});
    await expect(reader?.read()).rejects.toThrow("Sign in to continue.");
  });

  it("delivers none of a download's remaining bytes once another release of its App is current", async () => {
    const { builder, app, screen } = await openedApp();
    const id = await upload(
      screen.channel,
      blobOf(png(2 * fileLimits.chunkBytes), "image/png")
    );
    const response = await screen.channel.content("attachments", id);
    const reader = response.body?.getReader();
    await reader?.read();
    // The same files under a second version, so its screens stay trusted.
    const { version } = await builder.api.apps.files.commit(
      app,
      { ...files, "app.ts": `${files["app.ts"] ?? ""}\n// The second.\n` },
      "Second"
    );
    await builder.api.apps.versions.setCurrent(app, version);
    await expect(reader?.read()).rejects.toThrow(
      "That reference belongs to another version"
    );
  });

  it("delivers none of a download's remaining bytes once its screen's build is revoked", async () => {
    const { app, admin, artifacts, screen } = await openedApp();
    const id = await upload(
      screen.channel,
      blobOf(png(2 * fileLimits.chunkBytes), "image/png")
    );
    const response = await screen.channel.content("attachments", id);
    const reader = response.body?.getReader();
    await reader?.read();
    for (const artifact of artifacts) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await admin.api.screenTrust.revoke(app, artifact);
    }
    await expect(reader?.read()).rejects.toThrow(
      "The approval of this app's code was taken back."
    );
  });

  it("delivers none of a download's remaining bytes once its release is revoked, and starts none after", async () => {
    const { app, screen } = await openedApp();
    const id = await upload(
      screen.channel,
      blobOf(png(2 * fileLimits.chunkBytes), "image/png")
    );
    const response = await screen.channel.content("attachments", id);
    const reader = response.body?.getReader();
    await reader?.read();
    await revokeRelease(
      env,
      await actingPerson("admin"),
      { app: appIdSchema.parse(app), version: 1 },
      "Leaks data"
    );
    await expect(reader?.read()).rejects.toThrow(
      "The approval of this app's code was taken back."
    );
    await expect(
      codeOf(screen.channel.describe("attachments", id))
    ).resolves.toBe("screen.revoked");
  });

  it("ends a download that takes longer than a download may", async () => {
    const { screen } = await openedApp();
    const id = await upload(
      screen.channel,
      blobOf(png(2 * fileLimits.chunkBytes), "image/png")
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const response = await screen.channel.content("attachments", id);
      const reader = response.body?.getReader();
      await reader?.read();
      vi.setSystemTime(Date.now() + fileLimits.downloadMs + 1);
      await expect(reader?.read()).rejects.toThrow(
        "That file isn't available."
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves a file under its checked type's extension, never one a browser would run", async () => {
    const { app, screen } = await openedApp();
    const disposition = async (
      name: string,
      type: string,
      bytes: Uint8Array<ArrayBuffer>
    ) => {
      const id = await upload(screen.channel, blobOf(bytes, type), name);
      const response = await screen.channel.content("attachments", id);
      await response.body?.cancel();
      return {
        disposition: response.headers.get("content-disposition"),
        type: response.headers.get("content-type"),
        policy: response.headers.get("content-security-policy"),
        resourcePolicy: response.headers.get("cross-origin-resource-policy"),
      };
    };
    await expect(
      disposition(
        "Q3-report.html",
        "text/plain",
        utf8("<script>alert(1)</script>")
      )
    ).resolves.toStrictEqual({
      disposition: `attachment; filename="Q3-report.html.txt"; filename*=UTF-8''Q3-report.html.txt`,
      type: "text/plain; charset=utf-8",
      policy: "default-src 'none'; sandbox",
      resourcePolicy: "same-origin",
    });
    await expect(
      disposition("it's (final).png", "image/png", png())
    ).resolves.toMatchObject({
      disposition: `attachment; filename="it's (final).png"; filename*=UTF-8''it%27s%20%28final%29.png`,
    });
    // A name with a bidi override or another invisible character is no
    // file's name at all.
    const raw = rawChannel(screen, app);
    const refused = await Promise.all(
      [
        `invoice${String.fromCodePoint(0x20_2e)}txt.exe`,
        `zero${String.fromCodePoint(0x20_0b)}width.png`,
        `c1${String.fromCodePoint(0x85)}.png`,
      ].map(
        async (name) =>
          await answerOf(await raw.begin({ ...declaration(), name }))
      )
    );
    expect(refused).toStrictEqual([
      "file.invalid",
      "file.invalid",
      "file.invalid",
    ]);
  });

  it("holds a person to their unattached files and bytes, and a store to its bytes", async () => {
    const { release } = await openedApp();
    const codes: unknown[] = [];
    await onStore(release, (host, storeId) => {
      const start = (principal: string, size = 64): string =>
        host.files.begin(storeId, principal, "attachments", {
          ...declaration(),
          size,
        }).file;
      const published = (principal: string, size?: number): void => {
        const file = start(principal, size);
        host.files.publish(storeId, principal, "attachments", file, true);
      };
      // As if a record held every file published so far: what the test
      // arranges, since holding is a commit's to do.
      const holdAll = () => {
        host.ctx.storage.sql.exec(
          "UPDATE sdk_files SET expires_at = NULL WHERE state = 'published'"
        );
      };
      const big = fileLimits.bytes;
      for (let file = 0; file < fileLimits.unattachedPerPerson; file += 1) {
        published("one");
      }
      codes.push(
        refusal(() => {
          published("one");
        })
      );
      // One short of the limit, uploads started at once: an open upload
      // holds its slot, so only one may start, and none publish past it.
      for (let file = 1; file < fileLimits.unattachedPerPerson; file += 1) {
        published("three");
      }
      const started = Array.from({ length: fileLimits.openUploads }, () =>
        refusal(() => {
          start("three");
        })
      );
      codes.push(started.filter((code) => code === "admitted").length);
      holdAll();
      const perPerson = Math.floor(fileLimits.personBytes / big);
      for (let file = 0; file < perPerson - 1; file += 1) {
        published("two", big);
        holdAll();
      }
      codes.push(
        refusal(() => {
          published("two", big);
        }),
        refusal(() => {
          published("two", big);
        })
      );
      // The store as a whole, across people each within their own bytes.
      let refused: unknown = "admitted";
      const people =
        Math.ceil(fileLimits.storeBytes / fileLimits.personBytes) + 1;
      for (
        let person = 0;
        person < people && refused === "admitted";
        person += 1
      ) {
        for (
          let file = 0;
          file < perPerson - 1 && refused === "admitted";
          file += 1
        ) {
          refused = refusal(() => {
            published(`many-${person}`, big);
          });
          holdAll();
        }
      }
      codes.push(refused);
    });
    expect(codes).toStrictEqual([
      "file.unattached_limit",
      1,
      "admitted",
      "file.quota_exceeded",
      "file.quota_exceeded",
    ]);
  });

  it("gives chunks a budget of their own, a refused one counting too", async () => {
    const { app, screen } = await openedApp();
    const raw = rawChannel(screen, app);
    const file = crypto.randomUUID();
    // Twice the burst at once: each charged before anything else, so the
    // budget runs out whatever each costs after.
    const statuses = await Promise.all(
      Array.from(
        { length: 2 * fileLimits.chunkRequests.burst },
        async () => await statusOf(raw.put(file, 0, png(10), "0".repeat(64)))
      )
    );
    const limited = statuses.filter((status) => status === 429).length;
    expect(limited).toBeGreaterThan(0);
    expect(limited).toBeLessThanOrEqual(fileLimits.chunkRequests.burst);
  });

  it("keeps a chunk once recorded: a late write removes only its own object", async () => {
    const { app, release, screen, builder } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    const storeId = storeIdSchema.parse(release.store?.storeId);
    // A write admitted, whose bytes are still on their way.
    const admitted: { key: string | null } = { key: null };
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (instance: DataStore) => {
        admitted.key = await instance.admitChunk(
          storeId,
          builder.userId,
          "attachments",
          file,
          0,
          bytes.length
        );
      }
    );
    // Meanwhile the chunk is sent again, recorded, and the file published.
    await expect(statusOf(raw.put(file, 0, bytes, sha))).resolves.toBe(200);
    await expect(answerOf(await raw.finish(file))).resolves.toMatchObject({
      state: "published",
    });
    // The late write lands, other bytes: not recorded, its object removed.
    const other = png(100).fill(7, 8);
    await env.FILES.put(admitted.key ?? "", other);
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (instance: DataStore) => {
        const recorded = instance.chunkStored(
          storeId,
          builder.userId,
          file,
          0,
          other.length,
          await sha256(other),
          admitted.key ?? ""
        );
        if (recorded !== "recorded") {
          await env.FILES.delete(admitted.key ?? "");
        }
      }
    );
    // And one sent after publication is refused outright.
    await expect(
      statusOf(raw.put(file, 0, other, await sha256(other)))
    ).resolves.toBe(409);
    const content = await screen.channel.content("attachments", file);
    const objects = await storedObjects(release);
    expect({
      bytes: await content.bytes(),
      objects: objects.length,
    }).toStrictEqual({
      bytes,
      objects: 1,
    });
  });

  it("records one of two writes of a chunk sent at once, and publishes only what it recorded", async () => {
    const { app, release, screen } = await openedApp();
    const raw = rawChannel(screen, app);
    const mine = png(100);
    const theirs = png(100).fill(9, 8);
    const file = await begunFile(
      await raw.begin({
        ...declaration(),
        size: 100,
        sha256: await sha256(mine),
      })
    );
    await Promise.all([
      raw.put(file, 0, mine, await sha256(mine)),
      raw.put(file, 0, theirs, await sha256(theirs)),
    ]);
    await expect(answerOf(await raw.status(file))).resolves.toMatchObject({
      received: [0],
    });
    await expect(storedObjects(release)).resolves.toHaveLength(1);
    const finished = await answerOf(await raw.finish(file));
    if (finished === "file.content_mismatch") {
      // The other write was recorded: rejected, never published.
      return;
    }
    const content = await screen.channel.content("attachments", file);
    await expect(content.bytes()).resolves.toStrictEqual(mine);
  });

  it("keeps a chunk sent again while its first write still ran, whichever is recorded first", async () => {
    const { app, release, screen, builder } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    const storeId = storeIdSchema.parse(release.store?.storeId);
    // The first write's request timed out at the page but ran on in core:
    // while the chunk sent again is being stored, the first records it.
    let firstRecorded: string | undefined;
    const recordFirst = async (): Promise<void> => {
      await runInDurableObject(
        env.DATA_STORES.getByName(storeId),
        async (instance: DataStore) => {
          const key = await instance.admitChunk(
            storeId,
            builder.userId,
            "attachments",
            file,
            0,
            bytes.length
          );
          await env.FILES.put(key ?? "", bytes);
          firstRecorded = instance.chunkStored(
            storeId,
            builder.userId,
            file,
            0,
            bytes.length,
            sha,
            key ?? ""
          );
        }
      );
    };
    const racing = new Proxy(env.FILES, {
      get: (target, property) => {
        if (property === "put") {
          return async (...args: Parameters<R2Bucket["put"]>) => {
            await recordFirst();
            return await target.put(...args);
          };
        }
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        const bound: unknown = value.bind(target);
        return bound;
      },
    });
    const again = await raw.put(file, 0, bytes, sha, { ...env, FILES: racing });
    // The chunk sent again is kept, not cancelled: its own object removed,
    // the first write's the chunk's, and the upload goes on.
    expect({
      status: again.status,
      answer: await again.json(),
      firstRecorded,
    }).toStrictEqual({
      status: 200,
      answer: { kept: true },
      firstRecorded: "recorded",
    });
    await expect(storedObjects(release)).resolves.toHaveLength(1);
    await expect(answerOf(await raw.finish(file))).resolves.toMatchObject({
      state: "published",
    });
  });

  it("keeps a chunk whose recording committed though its answer was lost", async () => {
    const { app, release, screen } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    // The store records the chunk; its answer never reaches the route.
    const stores = new Proxy(env.DATA_STORES, {
      get: (target, property) => {
        if (property === "getByName") {
          return (name: string) => lossyChunkAnswers(target.getByName(name));
        }
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        const bound: unknown = value.bind(target);
        return bound;
      },
    });
    const sent = await raw.put(file, 0, bytes, sha, {
      ...env,
      DATA_STORES: stores,
    });
    // Kept: the store recorded this write's object, which stays.
    expect({ status: sent.status, answer: await sent.json() }).toStrictEqual({
      status: 200,
      answer: { kept: true },
    });
    await expect(storedObjects(release)).resolves.toHaveLength(1);
    await expect(answerOf(await raw.finish(file))).resolves.toMatchObject({
      state: "published",
    });
    const content = await screen.channel.content("attachments", file);
    await expect(content.bytes()).resolves.toStrictEqual(bytes);
  });

  it("removes a write's object once it had time to settle, when neither its recording nor the check after answered", async () => {
    const { app, release, screen } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    // Neither the recording nor the check after reaches the store: the
    // route can't tell whether the chunk is recorded, so its object stays.
    const unreachable = new Proxy(env.DATA_STORES, {
      get: (target, property) => {
        if (property === "getByName") {
          return (name: string) =>
            new Proxy(target.getByName(name), {
              get: (stub, method) => {
                const value: unknown = Reflect.get(stub, method);
                if (typeof value !== "function") {
                  return value;
                }
                if (method === "chunkStored" || method === "chunkKey") {
                  return async () => {
                    await Promise.resolve();
                    throw new Error("The connection was reset.");
                  };
                }
                // A stub's methods are called on it, never bound.
                return async (...args: unknown[]) => {
                  const answer: unknown = await Reflect.apply(
                    value,
                    stub,
                    args
                  );
                  return answer;
                };
              },
            });
        }
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        const bound: unknown = value.bind(target);
        return bound;
      },
    });
    const lost = await raw.put(file, 0, bytes, sha, {
      ...env,
      DATA_STORES: unreachable,
    });
    await lost.body?.cancel();
    // Sent again, recorded, and published: the first write's object stays.
    const sent = await raw.put(file, 0, bytes, sha);
    await sent.body?.cancel();
    await expect(answerOf(await raw.finish(file))).resolves.toMatchObject({
      state: "published",
    });
    const before = await storedObjects(release);

    await sweepIn(release, purgeGraceMs + 1);

    const after = await storedObjects(release);
    expect({ before: before.length, after: after.length }).toStrictEqual({
      before: 2,
      after: 1,
    });
    const content = await screen.channel.content("attachments", file);
    await expect(content.bytes()).resolves.toStrictEqual(bytes);
  });

  it("removes a losing write's object once it had time to settle, though its writer never did", async () => {
    const { app, release, screen, builder } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    const storeId = storeIdSchema.parse(release.store?.storeId);
    const admitted: { key: string | null } = { key: null };
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (instance: DataStore) => {
        admitted.key = await instance.admitChunk(
          storeId,
          builder.userId,
          "attachments",
          file,
          0,
          bytes.length
        );
      }
    );
    // Another write of the chunk is recorded first; this one's bytes land
    // after, and it loses, but its writer never removes them.
    await expect(statusOf(raw.put(file, 0, bytes, sha))).resolves.toBe(200);
    await env.FILES.put(admitted.key ?? "", bytes);
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      (instance: DataStore) => {
        instance.chunkStored(
          storeId,
          builder.userId,
          file,
          0,
          bytes.length,
          sha,
          admitted.key ?? ""
        );
      }
    );
    const before = await storedObjects(release);
    await sweepIn(release, purgeGraceMs + 1);
    const after = await storedObjects(release);
    expect({ before: before.length, after: after.length }).toStrictEqual({
      before: 2,
      after: 1,
    });
  });

  it("removes again a write's object that lands after the alarm removed it", async () => {
    const { app, release, screen, builder } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    const storeId = storeIdSchema.parse(release.store?.storeId);
    const admitted: { key: string | null } = { key: null };
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (instance: DataStore) => {
        admitted.key = await instance.admitChunk(
          storeId,
          builder.userId,
          "attachments",
          file,
          0,
          bytes.length
        );
      }
    );
    await sweepIn(release, purgeGraceMs + 1);
    // Its put lands only now, and its writer never removes it.
    await env.FILES.put(admitted.key ?? "", bytes);
    await sweepIn(release, purgeGraceMs + 2);
    await expect(storedObjects(release)).resolves.toStrictEqual([]);
  });

  it("tries again at the alarm's next try to remove a write's object whose removal failed", async () => {
    const { app, release, screen, builder } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    const storeId = storeIdSchema.parse(release.store?.storeId);
    const admitted: { key: string | null } = { key: null };
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (instance: DataStore) => {
        admitted.key = await instance.admitChunk(
          storeId,
          builder.userId,
          "attachments",
          file,
          0,
          bytes.length
        );
      }
    );
    // Its put lands, and its writer never records it.
    await env.FILES.put(admitted.key ?? "", bytes);
    const due: { failed?: unknown; next: number | null } = { next: null };
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (_instance, state) => {
        const host = new StoreHost(state, { ...env, FILES: failingDeletes });
        try {
          await host.files.sweep(storeId, Date.now() + purgeGraceMs + 1);
        } catch (error) {
          due.failed = error;
        }
        due.next = host.files.nextDue();
      }
    );
    const kept = await storedObjects(release);
    await sweepIn(release, purgeGraceMs + 2);
    expect({
      failed: due.failed instanceof Error,
      // Due again at once, which the alarm puts off by its retry wait:
      // never only once the write could no longer land.
      dueSoon: (due.next ?? Number.POSITIVE_INFINITY) <= Date.now(),
      kept: kept.length,
      after: await storedObjects(release),
    }).toStrictEqual({ failed: true, dueSoon: true, kept: 1, after: [] });
  });

  it("checks an upload's bytes once however many finishes arrive at once, answering each with the file", async () => {
    const { app, screen } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    await expect(statusOf(raw.put(file, 0, bytes, sha))).resolves.toBe(200);
    const { promise: open, resolve: letThrough } =
      Promise.withResolvers<null>();
    const { seen, reading } = gatedReads(open);
    const gated = { ...env, FILES: reading };
    const first = raw.finish(file, gated);
    await vi.waitFor(() => {
      expect(seen.reads).toBe(1);
    });
    const second = raw.finish(file, gated);
    // The second has reached the store, where it waits for the first.
    await scheduler.wait(250);
    letThrough(null);
    const answers = await Promise.all([
      answerOf(await first),
      answerOf(await second),
    ]);
    expect({
      reads: seen.reads,
      answers: answers.map((answer) =>
        typeof answer === "object" && answer !== null && "state" in answer
          ? answer.state
          : answer
      ),
    }).toStrictEqual({ reads: 1, answers: ["published", "published"] });
  });

  it("lets the next finish check an upload at once when a check failed before it could say", async () => {
    const { app, screen } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    await expect(statusOf(raw.put(file, 0, bytes, sha))).resolves.toBe(200);
    const unreadable = new Proxy(env.FILES, {
      get: (target, property) => {
        if (property === "get") {
          return async () => {
            await Promise.resolve();
            throw new Error("R2 is unavailable.");
          };
        }
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        const bound: unknown = value.bind(target);
        return bound;
      },
    });
    const failed = await statusOf(
      raw.finish(file, { ...env, FILES: unreadable })
    );
    const started = Date.now();
    const again = await answerOf(await raw.finish(file));
    expect({
      failed,
      again,
      // Not held back until the failed check's claim ran out.
      atOnce: Date.now() - started < finishClaimMs / 2,
    }).toMatchObject({
      failed: 500,
      again: { state: "published" },
      atOnce: true,
    });
  });

  it("sets the alarm for a chunk write's cleanup once it admits one", async () => {
    const { app, release, screen, builder } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    const storeId = storeIdSchema.parse(release.store?.storeId);
    const alarm: { at: number | null } = { at: null };
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (instance: DataStore, state) => {
        // The upload's own expiry put off, as an idle store's would be.
        await state.storage.deleteAlarm();
        await instance.admitChunk(
          storeId,
          builder.userId,
          "attachments",
          file,
          0,
          bytes.length
        );
        alarm.at = await state.storage.getAlarm();
      }
    );
    expect(alarm.at).not.toBeNull();
    expect((alarm.at ?? 0) - Date.now()).toBeLessThanOrEqual(
      purgeGraceMs + 60_000
    );
  });

  it("never records a write the alarm removed for taking too long to settle, and takes the chunk sent again", async () => {
    const { app, release, screen, builder } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    const storeId = storeIdSchema.parse(release.store?.storeId);
    const admitted: { key: string | null } = { key: null };
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (instance: DataStore) => {
        admitted.key = await instance.admitChunk(
          storeId,
          builder.userId,
          "attachments",
          file,
          0,
          bytes.length
        );
      }
    );
    // Its bytes land, but its recording comes only after the alarm took
    // it for one that never settled.
    await env.FILES.put(admitted.key ?? "", bytes);
    await sweepIn(release, purgeGraceMs + 1);
    const answered: { record: unknown } = { record: undefined };
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      (instance: DataStore) => {
        answered.record = instance.chunkStored(
          storeId,
          builder.userId,
          file,
          0,
          bytes.length,
          sha,
          admitted.key ?? ""
        );
      }
    );
    expect({
      record: answered.record,
      objects: await storedObjects(release),
    }).toStrictEqual({ record: "expired", objects: [] });
    // The upload is still open: the chunk sent again is kept, and it
    // publishes.
    await expect(
      answerOf(await raw.put(file, 0, bytes, sha))
    ).resolves.toStrictEqual({ kept: true });
    await expect(answerOf(await raw.finish(file))).resolves.toMatchObject({
      state: "published",
    });
  });

  it("answers a chunk whose write took too long to settle as one to send again, its upload still open", async () => {
    const { app, release, screen } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    // Its put lands only once the alarm took it for one that never settles.
    const slow = new Proxy(env.FILES, {
      get: (target, property) => {
        if (property === "put") {
          return async (...args: Parameters<R2Bucket["put"]>) => {
            await sweepIn(release, purgeGraceMs + 1);
            return await target.put(...args);
          };
        }
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        const bound: unknown = value.bind(target);
        return bound;
      },
    });
    const slowAnswer = await raw.put(file, 0, bytes, sha, {
      ...env,
      FILES: slow,
    });
    expect({
      status: slowAnswer.status,
      code: await answerOf(slowAnswer),
    }).toStrictEqual({ status: 503, code: "internal.unexpected" });
    await expect(
      answerOf(await raw.put(file, 0, bytes, sha))
    ).resolves.toStrictEqual({ kept: true });
    await expect(answerOf(await raw.finish(file))).resolves.toMatchObject({
      state: "published",
    });
  });

  it("records nothing of a chunk written after its store was deleted, so its writer removes it", async () => {
    const { app, release, screen, builder } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: 100, sha256: sha })
    );
    const storeId = storeIdSchema.parse(release.store?.storeId);
    let answered: string | undefined;
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (instance: DataStore, state) => {
        const key = await instance.admitChunk(
          storeId,
          builder.userId,
          "attachments",
          file,
          0,
          100
        );
        await new StoreHost(state, env).close(storeId, { type: "system" });
        answered = instance.chunkStored(
          storeId,
          builder.userId,
          file,
          0,
          100,
          sha,
          key ?? ""
        );
      }
    );
    expect(answered).toBe("ended");
  });

  it("reads an uploader's file through its record once a record holds it", async () => {
    const { builder, app, api } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const id = await upload(
      colleague.screen.channel,
      blobOf(png(), "image/png")
    );
    await expect(
      colleague.screen.channel.describe("attachments", id)
    ).resolves.toMatchObject({ id });
    // In the vault, which only builders read: not even its uploader reads it.
    await colleague.client.mutation(api.stash, { file: { id } });
    await expect(
      codeOf(colleague.screen.channel.describe("attachments", id))
    ).resolves.toBe("file.not_found");
  });

  it("moves a file from a record deleted to one written before it in the same commit", async () => {
    const { client, api, screen } = await openedApp();
    const id = await upload(screen.channel, blobOf(png(), "image/png"));
    const note = await client.mutation(api.create, { title: "Old" });
    await client.mutation(api.attachFile, {
      id: note,
      expectedRevision: 1,
      file: { id },
    });
    const renewed = await client.mutation(api.renew, {
      id: note,
      expectedRevision: 2,
      file: { id },
    });
    expect({
      renewed: typeof renewed,
      read: await screen.channel.describe("attachments", id),
    }).toMatchObject({ renewed: "string", read: { id } });
  });

  it("lets an uploader attach a new file to records they can and can't read in one commit, in either order", async () => {
    const { builder, app, api } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const kept = async (vaultFirst: boolean) => {
      const id = await upload(
        colleague.screen.channel,
        blobOf(png(), "image/png")
      );
      await colleague.client.mutation(api.keepTwice, {
        file: { id },
        vaultFirst,
      });
      // Readable through the board, whatever the vault says.
      const read = await colleague.screen.channel.describe("attachments", id);
      return read.id === id;
    };
    expect([await kept(true), await kept(false)]).toStrictEqual([true, true]);
  });

  it("never lets its uploader hold a file again through App code once a record they can't read holds it", async () => {
    const { builder, app, api } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const held = await upload(
      colleague.screen.channel,
      blobOf(png(), "image/png")
    );
    const loose = await upload(
      colleague.screen.channel,
      blobOf(png(), "image/png")
    );
    // In the vault, which only builders read; then pinned to the board,
    // which every member reads, by a reference App code made itself.
    await colleague.client.mutation(api.stash, { file: { id: held } });
    expect({
      held: await codeOf(
        colleague.client.mutation(api.pinById, { fileId: held })
      ),
      loose: typeof (await colleague.client.mutation(api.pinById, {
        fileId: loose,
      })),
      read: await codeOf(
        colleague.screen.channel.describe("attachments", held)
      ),
    }).toStrictEqual({
      held: "file.not_found",
      loose: "string",
      read: "file.not_found",
    });
  });

  it("lets a person read a file through the one record of many holding it they may read", async () => {
    const { builder, app, client, api, screen } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const id = await upload(screen.channel, blobOf(png(), "image/png"));
    // Many vault entries, which only builders read; then the board, which
    // every member reads.
    await client.mutation(api.stashMany, { file: { id }, count: 80 });
    await client.mutation(api.pin, { file: { id } });
    await expect(
      colleague.screen.channel.describe("attachments", id)
    ).resolves.toMatchObject({ id });
  });

  it("attaches only a file uploaded through a resource that declares attach", async () => {
    const { client, api, screen } = await openedApp();
    const id = await upload(
      screen.channel,
      blobOf(png(), "image/png"),
      "me.png",
      "avatars"
    );
    const note = await client.mutation(api.create, { title: "Profile" });
    await expect(
      codeOf(
        client.mutation(api.attachFile, {
          id: note,
          expectedRevision: 1,
          file: { id },
        })
      )
    ).resolves.toBe("file.not_found");
  });

  it("audits someone else's preview as a preview and their download as a download, and previews only an image", async () => {
    const { builder, app, client, api, screen } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const image = await upload(screen.channel, blobOf(png(), "image/png"));
    const text = await upload(
      screen.channel,
      blobOf(utf8("Plain words."), "text/plain")
    );
    const note = await client.mutation(api.create, { title: "Shared" });
    await client.mutation(api.attachFile, {
      id: note,
      expectedRevision: 1,
      file: { id: image },
    });
    await client.mutation(api.attachFile, {
      id: note,
      expectedRevision: 2,
      file: { id: text },
    });
    const previewed = await colleague.screen.channel.preview(
      "attachments",
      image
    );
    await previewed.arrayBuffer();
    const refused = await codeOf(
      colleague.screen.channel.preview("attachments", text)
    );
    await colleague.client.files.download(resources.attachments, {
      id: image,
    });
    const events = await fileEvents();
    expect({
      image: events
        .filter(({ file }) => file === image)
        .map(({ said }) => said)
        .toSorted(),
      refused,
    }).toStrictEqual({
      image: [
        `file.downloaded:${colleague.userId}`,
        `file.previewed:${colleague.userId}`,
        `file.published:${builder.userId}`,
      ].toSorted(),
      refused: "file.invalid",
    });
  });

  it("audits a person's downloads of a file once a day, though the first was logged before the next", async () => {
    const { builder, app, client, api, screen } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const kept = await upload(screen.channel, blobOf(png(), "image/png"));
    const note = await client.mutation(api.create, { title: "Shared" });
    await client.mutation(api.attachFile, {
      id: note,
      expectedRevision: 1,
      file: { id: kept },
    });
    await colleague.client.files.download(resources.attachments, { id: kept });
    // Logged, its outbox row gone, before the next download that day.
    const before = await gaps();
    await colleague.client.files.download(resources.attachments, { id: kept });
    const after = await gaps();
    const events = await fileEvents();
    expect({
      gaps: after - before,
      downloads: events.filter(
        ({ file, said }) =>
          file === kept && said === `file.downloaded:${colleague.userId}`
      ).length,
    }).toStrictEqual({ gaps: 0, downloads: 1 });
  });

  it("audits publication, deletion by its uploader or the platform, and downloads by anyone else", async () => {
    const { builder, app, client, api, release, screen } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const kept = await upload(screen.channel, blobOf(png(), "image/png"));
    const note = await client.mutation(api.create, { title: "Shared" });
    await client.mutation(api.attachFile, {
      id: note,
      expectedRevision: 1,
      file: { id: kept },
    });
    // Downloaded twice by a colleague, once by its uploader.
    await colleague.client.files.download(resources.attachments, { id: kept });
    await colleague.client.files.download(resources.attachments, { id: kept });
    await client.files.download(resources.attachments, { id: kept });
    const deleted = await upload(screen.channel, blobOf(png(), "image/png"));
    await client.files.delete(resources.attachments, { id: deleted });
    const orphan = await upload(screen.channel, blobOf(png(), "image/png"));
    await sweepIn(release, fileLimits.orphanMs + 1);
    await codeOf(
      upload(screen.channel, blobOf(utf8("not a png"), "image/png"))
    );
    const events = await fileEvents();
    expect({
      kept: events.filter(({ file }) => file === kept).map(({ said }) => said),
      deleted: events
        .filter(({ file }) => file === deleted)
        .map(({ said }) => said),
      orphan: events
        .filter(({ file }) => file === orphan)
        .map(({ said }) => said),
      rejected: events.filter(
        ({ said, uploadedBy }) =>
          said === "file.deleted:system:rejected" &&
          uploadedBy === builder.userId
      ).length,
    }).toStrictEqual({
      kept: [
        `file.published:${builder.userId}`,
        `file.downloaded:${colleague.userId}`,
      ],
      deleted: [
        `file.published:${builder.userId}`,
        `file.deleted:${builder.userId}`,
      ],
      orphan: [
        `file.published:${builder.userId}`,
        "file.deleted:system:orphaned",
      ],
      rejected: 1,
    });
  });
});
