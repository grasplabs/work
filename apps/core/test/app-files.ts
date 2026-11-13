import type { FilesReference, Id } from "@grasp-os/runtime/app";
import { fileChannel, GraspClient } from "@grasp-os/runtime/host";
import type { FileChannel, FileTransport } from "@grasp-os/runtime/host";
import { GraspError } from "@grasp-os/runtime/page";
import {
  appFilesPath,
  fileChunkHashHeader,
  fileLimits,
} from "@grasp-os/shared/app-file-limits";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import { pagePersonHeader } from "@grasp-os/shared/page-limits";
import { pageLeaseHeader } from "@grasp-os/shared/pages";
import type { Role } from "@grasp-os/shared/roles";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { StoreHost } from "../src/store-host.ts";
import { commitApp, testApp } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { allEvents } from "./audit-events.ts";
import type { Idp } from "./idp.ts";
import { referenceTo } from "./notes-client-app.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { routed, signedInApi } from "./sign-in.ts";

// The App the files tests (app-files-*.test.ts) upload to, read and
// download from: its source, its functions as its session client calls
// them, its page's file channel, and the ways the tests break core's
// side of it. Each file calls `appsOf(mockIdp())` once, for its people.

export const files: TestApp = testApp(
  {
    name: "Notes",
    tables: {
      notes: {
        fields: {
          title: "v.string().trim().min(1).max(200)",
          attachments: "v.array(v.file()).max(20).default([])",
        },
        access: { read: "appMembers", write: "owner" },
      },
      vault: {
        fields: { file: "v.file()" },
        access: { read: "appBuilders", write: "owner" },
      },
      board: {
        fields: { file: "v.file().nullable().default(null)" },
        access: { read: "appMembers", write: "appMembers" },
      },
    },
    permissions: [
      'permission.files({\n  operations: ["upload", "read", "attach", "delete"],\n})',
    ],
  },
  {
    "server/notes.ts": `import { AppError, v } from "@grasp-os/sdk";
import { doc, mutation, query } from "@server/_generated/server";

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
  args: { id: v.id("notes"), file: v.file() },
  returns: doc("notes"),
  handler: async (ctx, args) => {
    const note = await ctx.db.get("notes", args.id);
    if (!note) throw new AppError("note.not_found", "The note is unavailable.");
    if (note.attachments.some((file) => file.id === args.file.id)) return note;
    await ctx.db.patch("notes", args.id, { attachments: [...note.attachments, args.file] });
    const updated = await ctx.db.get("notes", args.id);
    if (!updated) throw new AppError("note.not_found", "The note is unavailable.");
    return updated;
  },
});

export const detachFile = mutation({
  args: { id: v.id("notes"), file: v.file() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const note = await ctx.db.get("notes", args.id);
    if (!note) throw new AppError("note.not_found", "The note is unavailable.");
    await ctx.db.patch("notes", args.id, { attachments: note.attachments.filter((file) => file.id !== args.file.id) });
    return null;
  },
});

export const remove = mutation({
  args: { id: v.id("notes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete("notes", args.id);
    return null;
  },
});

/** Moves a note's file to a new note, written first, then deletes the note. */
export const renew = mutation({
  args: { id: v.id("notes"), file: v.file() },
  returns: v.id("notes"),
  handler: async (ctx, args) => {
    const renewed = await ctx.db.insert("notes", { title: "Renewed", attachments: [args.file] });
    await ctx.db.delete("notes", args.id);
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
  args: { id: v.id("board"), file: v.file() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("board", args.id, { file: null });
    return null;
  },
});
`,

    "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { useFile, useUpload } from "@grasp-os/sdk/react";
import { permissions } from "@server/_generated/api";

function Notes() {
  const upload = useUpload(permissions.files);
  const shown = useFile(permissions.files, upload.status === "completed" ? upload.file : "skip");
  return <p>{upload.status} {shown?.name ?? ""}</p>;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
  }
);

/** A note as the App's queries return it. */
interface Note {
  _id: Id<"notes">;
  title: string;
  attachments: { id: string }[];
}

interface FileArgs {
  id: Id<"notes">;
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
  remove: referenceTo<{ id: Id<"notes"> }, null, "mutation">(
    release,
    "notes.remove"
  ),
  stash: referenceTo<{ file: { id: string } }, string, "mutation">(
    release,
    "notes.stash"
  ),
  pin: referenceTo<{ file: { id: string } }, string, "mutation">(
    release,
    "notes.pin"
  ),
  renew: referenceTo<{ id: string; file: { id: string } }, string, "mutation">(
    release,
    "notes.renew"
  ),
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
  unpin: referenceTo<{ id: string; file: { id: string } }, null, "mutation">(
    release,
    "notes.unpin"
  ),
});

/** The App's `permissions`, as its pages import them from `@server/_generated/api`. */
export const permissions = {
  files: {
    kind: "files",
    alias: "files",
    operations: ["upload", "read", "attach", "delete"],
  },
} as const satisfies Record<string, FilesReference>;

type Person = Awaited<ReturnType<typeof signedInApi>>;

/**
 * `person`'s open page of `app`: its lease, the person it names, and the
 * page's channel. A request the test sends itself names them too, unless
 * it names someone.
 */
export const pageOf = async (person: Person, app: string) => {
  const { lease } = await person.api.pages.open(app);
  const fetch = async (path: string, init: RequestInit, coreEnv?: Env) => {
    const headers = new Headers(init.headers);
    headers.set("origin", clientOrigin);
    headers.set("cookie", person.session);
    if (!headers.has(pagePersonHeader)) {
      headers.set(pagePersonHeader, person.userId);
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
 * reaches it (apps/web's page-files.ts): a download read to its end,
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

type Page = Awaited<ReturnType<typeof pageOf>>;

/**
 * The session client of `page` of `app`, as the frame's runtime mounts
 * it, over the page's relay of its calls and files; and what it
 * downloaded.
 */
const clientOf = (page: Page, app: string) => {
  const downloads: Downloads = new Map();
  const client = new GraspClient({
    call: async (request) => {
      const response = await page.fetch(`/api/app-functions/${app}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [pageLeaseHeader]: page.lease,
          [pagePersonHeader]: page.person,
        },
        body: request,
      });
      return await response.json();
    },
    // These tests read and change; none follows a query.
    watch: async () => await Promise.reject(new Error("No follows here")),
    files: pageFiles(page.channel, downloads),
  });
  return { client, downloads };
};

/**
 * The people of `idp`'s organization, and the Notes App as they reach it:
 * released by a builder, open in their page, shared with a colleague.
 */
export const appsOf = (idp: Idp) => {
  const personApi = async (role: Role) => await signedInApi(idp, role);

  /** A builder's Notes App, made current, and an admin of its organization. */
  const releasedApp = async (builder: Person) => {
    const admin = await personApi("admin");
    const { id } = await builder.api.apps.create({ name: "Notes" });
    const { version } = await commitApp(
      builder.api.apps.files,
      id,
      files,
      "First"
    );
    await builder.api.versions.rollback({ kind: "app", id }, version);
    return {
      app: id,
      release: await loadRelease(env, id, version),
      admin,
    };
  };

  /** A builder's App, open in their page, with its client and API. */
  const openedApp = async () => {
    const builder = await personApi("builder");
    const { app, release, admin } = await releasedApp(builder);
    const page = await pageOf(builder, app);
    return {
      builder,
      app,
      release,
      admin,
      api: apiOf(release),
      page,
      ...clientOf(page, app),
    };
  };

  /** A colleague `builder` shared `app` with, its page open. */
  const colleagueOf = async (builder: Person, app: string) => {
    const colleague = await personApi("user");
    await builder.api.apps.members.add(app, {
      type: "person",
      id: colleague.userId,
      role: "user",
    });
    const page = await pageOf(colleague, app);
    return { userId: colleague.userId, page, ...clientOf(page, app) };
  };

  return { personApi, releasedApp, openedApp, colleagueOf };
};

/** A PNG's bytes: its signature, then `size` bytes in all. */
export const png = (size = 64): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let at = 8; at < size; at += 1) {
    bytes[at] = at % 251;
  }
  return bytes;
};

export const blobOf = (bytes: Uint8Array<ArrayBuffer>, type: string): Blob =>
  new Blob([bytes], { type });

export const never = new AbortController().signal;

/** Uploads `blob` through `channel`, reporting nothing. */
export const upload = async (
  channel: FileChannel,
  blob: Blob,
  name = "photo.png",
  resource = "files"
): Promise<string> =>
  await channel.upload(resource, blob, name, {
    cancel: never,
    onProgress: () => {
      // Nothing to show.
    },
  });

/** Why `promise` rejected: its code. */
export const codeOf = async (promise: Promise<unknown>): Promise<unknown> => {
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
export const onStore = async (
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
export const sweepIn = async (
  release: Release,
  inMs: number
): Promise<void> => {
  await onStore(release, async (host, storeId) => {
    await host.files.sweep(storeId, Date.now() + inMs);
  });
};

/** The keys of the R2 objects of `release`'s store's files. */
export const storedObjects = async (release: Release): Promise<string[]> => {
  const listed = await env.FILES.list({
    prefix: `app-files/${release.store?.storeId ?? ""}/`,
  });
  return listed.objects.map(({ key }) => key);
};

/** A response's status, once it answered. */
export const statusOf = async (
  answered: Promise<Response>
): Promise<number> => {
  const response = await answered;
  await response.body?.cancel();
  return response.status;
};

/** `text` as UTF-8 bytes. */
export const utf8 = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new TextEncoder().encode(text));

/**
 * The audit events about files in core's audit outbox, each as its action,
 * then who did it (a person's ID, or `system` and how), oldest first.
 */
/** How many gaps the audit log recorded: a conflicting event makes one. */
export const gaps = async (): Promise<number> => {
  const logged = await allEvents();
  return logged.filter(({ action }) => action === "audit.gap").length;
};

export const fileEvents = async (): Promise<
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
export const refusal = (work: () => void): unknown => {
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
export const sha256 = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");

/** A JSON answer's `code`, or its `file` when it has none. */
export const answerOf = async (response: Response): Promise<unknown> => {
  const body: unknown = await response.json();
  return typeof body === "object" && body !== null && "code" in body
    ? body.code
    : body;
};

/**
 * Raw requests of `page`'s file channel for `app`'s `files`, as
 * a page that doesn't follow the protocol would send them.
 */
export const rawChannel = (page: Page, app: string) => {
  const base = `${appFilesPath}/${app}/files/uploads`;
  const leased = { [pageLeaseHeader]: page.lease };
  return {
    begin: async (body: unknown) =>
      await page.fetch(base, {
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
      await page.fetch(
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
      await page.fetch(`${base}/${file}`, { headers: leased }),
    finish: async (file: string, coreEnv?: Env) =>
      await page.fetch(
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
export const gatedReads = (open: Promise<null>) => {
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

/** The claim a finish's `publishable` took, or "" for none. */
export const claimOf = (found: unknown): string =>
  typeof found === "object" && found !== null && "claim" in found
    ? String(found.claim)
    : "";

/** R2 as core sees it, but that every deletion fails. */
export const failingDeletes = new Proxy(env.FILES, {
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
export const lossyChunkAnswers = (stub: object): object =>
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
export const asksHeld = (path: string, init: RequestInit) =>
  /\/uploads\/[^/]+$/u.test(path) && (init.method ?? "GET") === "GET";

/**
 * A request that never answers, until its signal stops it, as a
 * browser's over a network gone quiet: rejected then as the browser would.
 */
export const neverAnswered = async (init: RequestInit): Promise<Response> => {
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
export const brokenPartway = (response: Response): Response => {
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
export const fileStates = async (release: Release): Promise<string[]> => {
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
export const begunFile = async (response: Response): Promise<string> => {
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
export const uploadKey = (): string => crypto.randomUUID().replaceAll("-", "");

/** An upload's start, as a page declares it, under a key of its own. */
export const declaration = () => ({
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
 * `page`'s file channel for `app`, over a network that delivers an
 * upload's finish and its cancellation in the order `first` says: the
 * other waits until `first` was answered (or, should `first` never be
 * sent, a few seconds).
 */
export const orderedChannel = (
  page: Page,
  app: string,
  first: "finish" | "cancel"
): FileChannel => {
  const { promise: answered, resolve } = Promise.withResolvers<null>();
  const fallback = setTimeout(() => {
    resolve(null);
  }, 5000);
  return fileChannel({
    app,
    lease: page.lease,
    person: page.named,
    fetch: async (path, init) => {
      const which = lastStepOf(path, init);
      if (which !== "other" && which !== first) {
        await answered;
      }
      const response = await page.fetch(path, init);
      if (which === first) {
        clearTimeout(fallback);
        resolve(null);
      }
      return response;
    },
  });
};
