import type { Id, OperationReference, ReferenceKind } from "@grasp-os/sdk";
import { GraspError } from "@grasp-os/sdk/client";
import { GraspClient } from "@grasp-os/sdk/host";
import type { ClientTransport } from "@grasp-os/sdk/host";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import { appFunctionPath, screenLeaseHeader } from "@grasp-os/shared/screens";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { versionFiles } from "../src/apps.ts";
import { withScreenReferences } from "../src/screen-references.ts";
import { buildScreens } from "../src/screens.ts";
import { StoreHost } from "../src/store-host.ts";
import { mockIdp } from "./idp.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { routed, signedInApi } from "./sign-in.ts";

// The session client a screen's queries, mutations and actions go through
// (spec 10.1, 10.7.1), against core's real function route, as an approved
// screen's page relays them: a Notes App created, loaded, edited and
// deleted; a lost response recovered from its receipt, never saved twice;
// a cancelled save that still commits and can't be duplicated; caller
// keys reused for other input or past their receipt refused; an action's
// lost response never repeated; and arguments the operation can't take
// refused before anything is sent.

const idp = mockIdp();

const files: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
};

export default defineSchema({
  notes: defineTable(noteFields).index("by_updated", ["_updatedAt"]),
});
`,
  "operations/notes.ts": `import { AppError, paginationOptionsValidator, paginationResultValidator, v } from "@grasp-os/sdk";
import { action, doc, mutation, query } from "#grasp/server";
import { noteFields } from "../schema.ts";

export const list = query({
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(doc("notes")),
  handler: async (ctx, args) =>
    await ctx.db.query("notes").withIndex("by_updated").order("desc").paginate(args.pagination),
});

export const get = query({
  args: { id: v.id("notes") },
  returns: doc("notes").nullable(),
  handler: async (ctx, args) => await ctx.db.get("notes", args.id),
});

export const create = mutation({
  args: { title: noteFields.title, body: noteFields.body },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const update = mutation({
  args: {
    id: v.id("notes"),
    expectedRevision: v.number().integer().min(1),
    title: noteFields.title,
    body: v.string().max(100_000),
  },
  returns: doc("notes"),
  handler: async (ctx, args) => {
    await ctx.db.patch("notes", args.id, { title: args.title, body: args.body }, { expectedRevision: args.expectedRevision });
    const updated = await ctx.db.get("notes", args.id);
    if (!updated) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    return updated;
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

export const echo = action({
  args: { word: v.string().default("hello") },
  returns: v.string(),
  handler: async (_ctx, args) => args.word,
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { create, echo, get, list, remove, update } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { notes: { list, get, create, update, remove, echo } },
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
  "screens/notes.tsx": `import { useMutation, useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { api } from "#grasp";

export default function Notes() {
  const notes = useQuery(api.notes.list, { pagination: { pageSize: 50 } });
  const create = useMutation(api.notes.create);
  if (notes === undefined) {
    return <p role="status">Loading notes…</p>;
  }
  return (
    <main className="flex flex-col gap-3 p-6">
      <ul>
        {notes.items.map((note) => (
          <li key={note._id}>{note.title}</li>
        ))}
      </ul>
      <Button onClick={() => void create({ title: "New note" })}>Add</Button>
    </main>
  );
}
`,
};

/** A note as the App's queries return it. */
interface Note {
  _id: Id<"notes">;
  _rev: number;
  _createdAt: number;
  _updatedAt: number;
  _ownerId: string;
  title: string;
  body: string;
}

type Page =
  | { items: Note[]; hasMore: false; nextCursor: null }
  | { items: Note[]; hasMore: true; nextCursor: string };

/** The reference to `path` of `release`, typed as the App's `#grasp` types it. */
const referenceTo = <Args, Return, Kind extends ReferenceKind>(
  release: Release,
  path: string
): OperationReference<Args, Return, Kind> => {
  const operation = release.app.operations[path];
  const fingerprint = release.fingerprints[path];
  if (operation === undefined || fingerprint === undefined) {
    throw new Error(`The release has no ${path}`);
  }
  // The same data the host generates into `#grasp` for this release (sdk
  // generate.ts), typed by hand as it would be.
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

/** The App's `api`, as its screens import it from `#grasp`. */
const apiOf = (release: Release) => ({
  list: referenceTo<
    { pagination: { cursor?: string | null; pageSize?: number } },
    Page,
    "query"
  >(release, "notes.list"),
  get: referenceTo<{ id: Id<"notes"> }, Note | null, "query">(
    release,
    "notes.get"
  ),
  create: referenceTo<
    { title: string; body?: string },
    Id<"notes">,
    "mutation"
  >(release, "notes.create"),
  update: referenceTo<
    { id: Id<"notes">; expectedRevision: number; title: string; body: string },
    Note,
    "mutation"
  >(release, "notes.update"),
  remove: referenceTo<
    { id: Id<"notes">; expectedRevision: number },
    null,
    "mutation"
  >(release, "notes.remove"),
  echo: referenceTo<{ word?: string }, string, "action">(release, "notes.echo"),
});

const personApi = async (role: Role) => await signedInApi(idp, role);

/**
 * A builder's Notes App, made current, its screen approved by an admin and
 * opened: the release, the screen's lease, and the builder's session.
 */
const openedApp = async () => {
  const builder = await personApi("builder");
  const admin = await personApi("admin");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  const { version } = await builder.api.apps.files.commit(id, files, "First");
  await builder.api.apps.versions.setCurrent(id, version);
  const review = await admin.api.screenTrust.review(id);
  await admin.api.screenTrust.approve(id, {
    version: review.version,
    generation: review.generation,
    artifacts: builtArtifacts(review.screens),
  });
  const { lease } = await builder.api.screens.open(id, "notes");
  const release = await loadRelease(env, id, version);
  return { app: id, lease, cookie: builder.session, release };
};

type Opened = Awaited<ReturnType<typeof openedApp>>;

/**
 * What the page does with a call the frame sends (apps/web's
 * screen-host.ts): posts it to core's function route under the screen's
 * lease, answers core's answer, and rejects a refusal with its code.
 */
const pageTransport = ({ app, lease, cookie }: Opened): ClientTransport => ({
  call: async (request) => {
    const response = await routed(`${appFunctionPath}/${app}`, {
      method: "POST",
      headers: {
        origin: clientOrigin,
        "content-type": "application/json",
        cookie,
        [screenLeaseHeader]: lease,
      },
      body: request,
    });
    const answer: unknown = await response.json();
    if (response.ok) {
      return answer;
    }
    const payload = errorPayloadSchema.parse(answer);
    throw Object.assign(new Error(payload.message), { code: payload.code });
  },
});

/** The network between page and core, which can drop answers on the way back. */
const network = (transport: ClientTransport) => {
  let dropping = 0;
  let sent = 0;
  return {
    transport: {
      call: async (request: string) => {
        sent += 1;
        const answer = await transport.call(request);
        if (dropping > 0) {
          dropping -= 1;
          // The request reached core; its answer didn't come back.
          throw new Error("The connection was reset.");
        }
        return answer;
      },
    } satisfies ClientTransport,
    /** Drops the next `count` answers. */
    drop: (count: number) => {
      dropping = count;
    },
    /** How many requests reached core so far. */
    sent: () => sent,
  };
};

/** A client over the page's transport, as the frame's runtime mounts it. */
const clientFor = (opened: Opened) => {
  const net = network(pageTransport(opened));
  return { client: new GraspClient(net.transport), net };
};

/** Why `promise` rejected: the structured error's code, category and details. */
const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof GraspError)) {
      throw error;
    }
    const { code, category, details } = error;
    return { code, category, details };
  }
  throw new Error("It resolved");
};

/** The titles of the notes the App holds, newest first. */
const titles = async (client: GraspClient, api: ReturnType<typeof apiOf>) => {
  const page = await client.query(api.list, { pagination: {} });
  return page.items.map((note) => note.title);
};

describe("the session client", { timeout: 120_000 }, () => {
  it("creates, loads, edits and deletes notes, with direct values", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);

    const id = await client.mutation(api.create, { title: "  Launch  " });
    const created = await client.query(api.get, { id });
    expect(created).toMatchObject({
      _id: id,
      title: "Launch",
      body: "",
      _rev: 1,
    });
    const edited = await client.mutation(api.update, {
      id,
      expectedRevision: 1,
      title: "Launch plan",
      body: "Ship it",
    });
    expect(edited).toMatchObject({
      title: "Launch plan",
      body: "Ship it",
      _rev: 2,
    });
    await expect(titles(client, api)).resolves.toStrictEqual(["Launch plan"]);
    await expect(
      client.mutation(api.remove, { id, expectedRevision: 2 })
    ).resolves.toBeNull();
    // Null is the query's own answer for a note that isn't there.
    await expect(client.query(api.get, { id })).resolves.toBeNull();
  });

  it("rejects a stale revision with data.conflict, and an App's own failure as it threw it", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const id = await client.mutation(api.create, { title: "Draft" });
    await client.mutation(api.update, {
      id,
      expectedRevision: 1,
      title: "Theirs",
      body: "",
    });
    await expect(
      failureOf(
        client.mutation(api.update, {
          id,
          expectedRevision: 1,
          title: "Mine",
          body: "",
        })
      )
    ).resolves.toMatchObject({ code: "data.conflict", category: "domain" });
    await expect(client.query(api.get, { id })).resolves.toMatchObject({
      title: "Theirs",
    });
  });

  it("recovers a mutation whose answer was lost from its receipt, saving it once", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, net } = clientFor(opened);
    net.drop(1);
    const id = await client.mutation(api.create, { title: "Once" });
    // The retry reached core and got the first commit's answer.
    expect(net.sent()).toBe(2);
    await expect(client.query(api.get, { id })).resolves.toMatchObject({
      title: "Once",
    });
    await expect(titles(client, api)).resolves.toStrictEqual(["Once"]);
  });

  it("makes each explicit call a submission of its own, and joins one with the same key and input", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const [first, second] = await Promise.all([
      client.mutation(api.create, { title: "Twin" }),
      client.mutation(api.create, { title: "Twin" }),
    ]);
    expect(first).not.toBe(second);
    const keyed = { idempotencyKey: "save-once" };
    const [one, again] = await Promise.all([
      client.mutation(api.create, { title: "Keyed" }, keyed),
      // Normalized as the host normalizes it: the same input.
      client.mutation(api.create, { title: " Keyed ", body: "" }, keyed),
    ]);
    expect(again).toBe(one);
    await expect(titles(client, api)).resolves.toHaveLength(3);
  });

  it("refuses a caller key reused for other input, and one whose receipt expired", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const keyed = { idempotencyKey: "monday-report" };
    const id = await client.mutation(api.create, { title: "Report" }, keyed);
    await expect(
      client.mutation(api.create, { title: "Report" }, keyed)
    ).resolves.toBe(id);
    await expect(
      failureOf(client.mutation(api.create, { title: "Other" }, keyed))
    ).resolves.toMatchObject({ code: "submission.key_conflict" });

    const store = opened.release.store?.storeId ?? "";
    await runInDurableObject(
      env.DATA_STORES.getByName(store),
      async (_instance, state) => {
        // The store's sweep, as at 31 days from now: past the receipt's
        // retention, within its tombstone's.
        await new StoreHost(state, env).sweepReceipts(
          new Date(Date.now() + 31 * 24 * 3_600_000)
        );
      }
    );
    await expect(
      failureOf(client.mutation(api.create, { title: "Report" }, keyed))
    ).resolves.toMatchObject({ code: "submission.expired" });
    await expect(titles(client, api)).resolves.toStrictEqual(["Report"]);
  });

  it("stops a cancelled caller waiting, while the save commits and can't be sent twice", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, net } = clientFor(opened);
    const keyed = { idempotencyKey: "cancelled-save" };
    const controller = new AbortController();
    // The answer is lost, so the save is still reconciling when it aborts.
    net.drop(1);
    const waiting = client.mutation(
      api.create,
      { title: "Kept" },
      { ...keyed, signal: controller.signal }
    );
    controller.abort();
    await expect(failureOf(waiting)).resolves.toMatchObject({
      code: "submission.cancelled",
      details: { sent: true },
    });
    // The same key and input joins the submission still in flight.
    const id = await client.mutation(api.create, { title: "Kept" }, keyed);
    await expect(titles(client, api)).resolves.toStrictEqual(["Kept"]);
    await expect(client.query(api.get, { id })).resolves.toMatchObject({
      title: "Kept",
    });
    // Aborted before it was sent, nothing is.
    const before = net.sent();
    await expect(
      failureOf(
        client.mutation(
          api.create,
          { title: "Never" },
          { signal: AbortSignal.abort() }
        )
      )
    ).resolves.toMatchObject({
      code: "submission.cancelled",
      details: { sent: false },
    });
    expect(net.sent()).toBe(before);
  });

  it("releases only the reader that aborts a query", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    await client.mutation(api.create, { title: "Shared" });
    const controller = new AbortController();
    const args = { pagination: { pageSize: 10 } };
    const aborted = client.query(api.list, args, { signal: controller.signal });
    const kept = client.query(api.list, args);
    controller.abort();
    await expect(failureOf(aborted)).resolves.toMatchObject({
      code: "query.cancelled",
    });
    await expect(kept).resolves.toMatchObject({
      items: [{ title: "Shared" }],
      hasMore: false,
    });
  });

  it("never sends an action again when its answer is lost, and recovers it by its key", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, net } = clientFor(opened);
    // The empty input may be left out: its default applies.
    await expect(client.action(api.echo)).resolves.toBe("hello");
    net.drop(1);
    const before = net.sent();
    const lost = await failureOf(client.action(api.echo, { word: "once" }));
    expect(lost).toMatchObject({
      code: "submission.outcome_unknown",
      category: "uncertain",
    });
    expect(net.sent()).toBe(before + 1);
    const { idempotencyKey } = z
      .object({ idempotencyKey: z.string() })
      .parse(lost.details);
    await expect(
      client.action(api.echo, { word: "once" }, { idempotencyKey })
    ).resolves.toBe("once");
  });

  it("refuses arguments and options the call can't take before sending anything", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, net } = clientFor(opened);
    await expect(
      failureOf(client.mutation(api.create, { title: "   " }))
    ).resolves.toMatchObject({
      code: "contract.invalid_args",
      category: "contract",
      details: { issues: [{ path: ["title"] }] },
    });
    await expect(
      failureOf(
        client.mutation(api.create, { title: "Fine" }, { idempotencyKey: "" })
      )
    ).resolves.toMatchObject({ code: "submission.key_invalid" });
    const id = await client.mutation(api.create, { title: "Real" });
    const sent = net.sent();
    // A query takes no key: the type refuses it, and so does the client.
    await expect(
      // @ts-expect-error -- a query takes no idempotency key
      client.query(api.get, { id }, { idempotencyKey: "no" })
    ).rejects.toThrow(TypeError);
    // A reference that isn't a public query.
    await expect(
      // @ts-expect-error -- a mutation isn't a query, and the client checks
      failureOf(client.query(api.create, { id }))
    ).resolves.toMatchObject({ code: "contract.invalid_request" });
    expect(net.sent()).toBe(sent);
  });
});

/** A screen of the Notes App whose component runs `body` first. */
const screen = (body: string): string =>
  `import { useMutation, useQuery } from "@grasp-os/sdk/react";
import { api } from "#grasp";

export default function Notes() {
${body}
  return null;
}
`;

describe("a screen's build", { timeout: 120_000 }, () => {
  it("builds a saved or drafted version's screens with the references its own code generates", async () => {
    // A save and a draft's check build alike (save-builds.ts): nothing of
    // either is sealed yet, so the references come from the files.
    const builder = await personApi("builder");
    const { id } = await builder.api.apps.create({ name: "Notes" });
    const { builds } = await builder.api.apps.files.commit(id, files, "First");
    expect(builds.screens).toMatchObject({ status: "ok", diagnostics: [] });
    const broken = await builder.api.apps.files.commit(
      id,
      {
        ...files,
        "screens/notes.tsx": screen(
          '  useQuery(api.notes.get, { noteId: "x" });'
        ),
      },
      "Second"
    );
    expect(broken.builds.screens.status).toBe("failed");
  });

  /** The diagnostics of version 1 of an App holding `files`, as core builds its screens. */
  const diagnosticsOf = async (
    appFiles: Record<string, string>
  ): Promise<string[]> => {
    const builder = await personApi("builder");
    const { id } = await builder.api.apps.create({ name: "Notes" });
    const { version } = await builder.api.apps.files.commit(
      id,
      appFiles,
      "First"
    );
    const build = await buildScreens(
      env,
      await withScreenReferences(
        env,
        appIdSchema.parse(id),
        version,
        await versionFiles(env, appIdSchema.parse(id), version)
      )
    );
    return build.diagnostics
      .filter(({ severity }) => severity === "error")
      .map(({ message }) => message);
  };

  it("loads the App's references and the React SDK into the screen", async () => {
    const opened = await openedApp();
    const build = await buildScreens(
      env,
      await withScreenReferences(
        env,
        appIdSchema.parse(opened.app),
        opened.release.manifest.resourceVersion,
        await versionFiles(
          env,
          appIdSchema.parse(opened.app),
          opened.release.manifest.resourceVersion
        )
      )
    );
    if (!build.ok) {
      throw new Error("The screen didn't build");
    }
    const closure = build.screens["app~screens~notes.js"];
    expect(closure?.modules).toStrictEqual([
      "app~.grasp~references.js",
      "app~screens~notes.js",
    ]);
    expect(closure?.kitModules).toContain("@grasp-os~sdk~react.js");
  });

  it("fails the type check on arguments a reference doesn't take, without a cast", async () => {
    await expect(
      diagnosticsOf({
        ...files,
        "screens/notes.tsx": screen(`  useQuery(api.notes.get, { noteId: "x" });
  const create = useMutation(api.notes.create);
  void create();`),
      })
    ).resolves.toStrictEqual([
      expect.stringContaining("noteId"),
      expect.stringContaining("Expected 1-2 arguments, but got 0"),
    ]);
  });

  it("refuses a screen that makes its own client", async () => {
    await expect(
      diagnosticsOf({
        ...files,
        "screens/notes.tsx": `import { GraspClient } from "@grasp-os/sdk/client";
export default function Notes() {
  return <p>{String(GraspClient)}</p>;
}
`,
      })
    ).resolves.toStrictEqual([
      expect.stringContaining("the platform's: it makes the session client"),
    ]);
  });

  it("tells an App without server code that it has no references yet", async () => {
    await expect(
      diagnosticsOf({
        "screens/notes.tsx": screen("  void api;"),
      })
    ).resolves.toStrictEqual([
      expect.stringContaining("which this App doesn't have yet"),
    ]);
  });
});
