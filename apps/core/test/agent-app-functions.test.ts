import { contractFingerprint, preferenceOperations } from "@grasp-os/sdk/host";
import { appIdSchema } from "@grasp-os/shared/ids";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { appHost } from "../src/durable-objects.ts";
import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

// `env.apps.call` in a chat's code: the chat's agent calling a public
// function of an App's sealed release, for its person. Starts from the
// ways it can fail: the agent calls without a permission of its own, or
// writes with one that only reads; the request reaches core as anything
// but a stream bounded before it is parsed.

const idp = mockIdp();

const files: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string().min(1).max(200) }),
});
`,
  "operations/notes.ts": `import { v } from "@grasp-os/sdk";
import { action, mutation, query } from "#grasp/server";

export const create = mutation({
  args: { title: v.string().min(1).max(200) },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const titles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).map((note) => note.title),
});

/**
 * Says it has started (a "started" note, committed at once), waits until
 * a "go" note appears, then writes: the test acts between the two.
 */
export const holdThenCreate = action({
  args: { title: v.string().min(1).max(200) },
  returns: v.null(),
  uses: [create, titles],
  handler: async (ctx, args) => {
    await ctx.runMutation(create, { title: "started" });
    for (let polls = 0; polls < 50; polls += 1) {
      const seen = await ctx.runQuery(titles, {});
      if (seen.includes("go")) {
        await ctx.runMutation(create, args);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  },
});
`,
  "app.ts": `import { app, v } from "@grasp-os/sdk";
import { create, holdThenCreate, titles } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "appMembers", write: "appMembers" } } },
  operations: { notes: { create, holdThenCreate, titles } },
  internalOperations: {},
  screens: [],
  preferences: v.object({ compact: v.boolean().default(false) }),
  uses: [],
});
`,
};

/** The call of `path` with `input`, as the chat's code writes it. */
const callOf = (release: Release, path: string, input: unknown): string =>
  JSON.stringify({
    reference: {
      resourceId: release.manifest.resourceId,
      resourceVersion: release.manifest.resourceVersion,
      contractId: path,
      fingerprint: release.fingerprints[path],
      kind: release.app.operations[path]?.kind,
    },
    input,
  });

/**
 * The call of the App's preference operation `name` with `input`, as the
 * chat's code writes it, naming `kind` (the operation's own unless given).
 */
const preferenceCallOf = async (
  release: Release,
  name: "get" | "update",
  input: unknown,
  kind?: string
): Promise<string> => {
  if (release.app.preferences === null) {
    throw new Error("The App declares no preferences");
  }
  const operation = preferenceOperations(release.app.preferences)[name];
  return JSON.stringify({
    reference: {
      resourceId: release.manifest.resourceId,
      resourceVersion: release.manifest.resourceVersion,
      contractId: operation.path,
      fingerprint: await contractFingerprint(operation),
      kind: kind ?? operation.kind,
    },
    input,
  });
};

/** Code that makes each call in turn: its result, or the error's code. */
const tryEach = (calls: Record<string, string>): string =>
  `export default async (self, env) => {
    const tried = async (call) => { try { return (await call()).result; } catch (error) { return error.code ?? error.message; } };
    const stream = (text) => new Blob([text]).stream();
    const results = {};
    ${Object.entries(calls)
      .map(
        ([name, call]) =>
          `results[${JSON.stringify(name)}] = await tried(async () => ${call});`
      )
      .join("\n    ")}
    return results;
  };`;

/** A builder's Notes App, activated, and the release that runs. */
const notesApp = async (existing?: Awaited<ReturnType<typeof signedInApi>>) => {
  const builder = existing ?? (await signedInApi(idp, "builder"));
  const { id } = await builder.api.apps.create({ name: "Notes" });
  const { version } = await builder.api.apps.files.commit(id, files, "First");
  await builder.api.apps.versions.setCurrent(id, version);
  return { builder, app: id, release: await loadRelease(env, id, version) };
};

const returnedSchema = z.record(z.string(), z.unknown());

/** What the chat's code returned. */
const returned = async (chat: Awaited<ReturnType<typeof chatOf>>) => {
  const [result] = await codeResults(chat.stub, chat.chat.id);
  return returnedSchema.parse(
    JSON.parse(result?.text.replace("Returned:\n", "") ?? "{}")
  );
};

/** Asks a chat of the builder's to run `code`, with the agent granted `actions` on the App. */
type Chat = Awaited<ReturnType<typeof chatOf>>;

interface RunOptions {
  /** Before the chat asks, once the grants are made. */
  before?: (chat: Chat) => Promise<void>;
  /** While the chat's turn runs, given the grants' IDs, the App's first. */
  during?: (chat: Chat, grants: string[]) => Promise<void>;
  /** Whose chat it is: the builder's unless another is given. */
  personId?: string;
  /** More of the agent's grants, each made by the builder. */
  alsoGrant?: {
    object: { type: "app"; appId: string };
    actions: ("read" | "write")[];
    binding: string;
  }[];
}

/** Asks a chat of the builder's to run `code`, with the agent granted `actions` on the App. */
const runIn = async (
  { builder, app }: Awaited<ReturnType<typeof notesApp>>,
  code: string,
  actions: ("read" | "write")[],
  { before, during, personId, alsoGrant = [] }: RunOptions = {}
) => {
  const chat = await chatOf(
    personId ?? builder.userId,
    codeStep(code),
    says("Done.")
  );
  const requests = [
    ...(actions.length > 0
      ? [
          {
            object: { type: "app" as const, appId: app },
            actions,
            binding: "NOTES",
          },
        ]
      : []),
    ...alsoGrant,
  ];
  const grants = await Promise.all(
    requests.map(
      async (request) =>
        await requestGranted(idp, builder, { subject: chat.agent, ...request })
    )
  );
  await before?.(chat);
  await Promise.all([chat.ask("Use the Notes App."), during?.(chat, grants)]);
  return { chat, returned: async () => await returned(chat) };
};

const run = async (
  notes: Awaited<ReturnType<typeof notesApp>>,
  code: string,
  actions: ("read" | "write")[]
) => {
  const { returned: result } = await runIn(notes, code, actions);
  return await result();
};

/** The App's notes, as its builder's screen would read them. */
const titlesOf = async ({
  builder,
  app,
  release,
}: Awaited<ReturnType<typeof notesApp>>): Promise<unknown> => {
  const { result } = await callAppFunction(
    env,
    { userId: builder.userId, role: "builder", teams: [] },
    app,
    callOf(release, "notes.titles", {})
  );
  return result;
};

/** Writes a note as the App's builder, from outside the chat. */
const noteAs = async (
  { builder, app, release }: Awaited<ReturnType<typeof notesApp>>,
  title: string
): Promise<void> => {
  await callAppFunction(
    env,
    { userId: builder.userId, role: "builder", teams: [] },
    app,
    callOf(release, "notes.create", { title })
  );
};

/** Waits until the App holds a note titled `title`. */
const untilNoted = async (
  notes: Awaited<ReturnType<typeof notesApp>>,
  title: string
): Promise<void> => {
  await vi.waitFor(
    async () => {
      const result = await titlesOf(notes);
      const titles = z.object({ value: z.array(z.string()) }).safeParse(result);
      expect(titles.success && titles.data.value.includes(title)).toBeTruthy();
    },
    { timeout: 10_000, interval: 100 }
  );
};

/** Waits until the chat's one App call has been recorded: it has ended. */
const settled = async (chat: Chat): Promise<void> => {
  await vi.waitFor(
    async () => {
      // oxlint-disable-next-line no-use-before-define -- defined below, called later
      await expect(appCalls(chat)).resolves.toHaveLength(1);
    },
    { timeout: 20_000, interval: 100 }
  );
};

/** Puts the chat in restricted mode, as a restricted read does. */
const restricted = async (chat: Chat): Promise<void> => {
  await chat.stub.restrictChat(chat.chat.id);
};

/** The `apps.call` audit events of the chat's agent. */
const appCalls = async (chat: Chat) => {
  const events = await allEvents();
  return events
    .filter(
      ({ actor, action, detail }) =>
        action === "agent.call" &&
        detail.method === "apps.call" &&
        actor.type === "agent" &&
        actor.agentId === chat.agent.agentId
    )
    .map(({ detail }) => ({ outcome: detail.outcome, reason: detail.reason }));
};

describe(
  "a chat's code calling an App's functions",
  { timeout: 120_000 },
  () => {
    it("reads with a read permission, and writes only with a write permission", async () => {
      const notes = await notesApp();
      const app = JSON.stringify(notes.app);
      const create = JSON.stringify(
        callOf(notes.release, "notes.create", { title: "From the agent" })
      );
      const titles = JSON.stringify(callOf(notes.release, "notes.titles", {}));
      const calls = {
        create: `env.apps.call(${app}, stream(${create}))`,
        titles: `env.apps.call(${app}, stream(${titles}))`,
      };

      const reading = await run(notes, tryEach(calls), ["read"]);
      expect(reading.titles).toStrictEqual({ ok: true, value: [] });
      expect(reading.create).toBe("permission.denied");

      const writing = await run(notes, tryEach(calls), ["read", "write"]);
      expect(writing.create).toMatchObject({ ok: true });
      expect(writing.titles).toStrictEqual({
        ok: true,
        value: ["From the agent"],
      });
    });

    it("reads its person's preferences with a read permission, and changes them only with a write permission", async () => {
      const notes = await notesApp();
      const app = JSON.stringify(notes.app);
      const update = { expectedRevision: 0, patch: { compact: true } };
      const calls = {
        get: `env.apps.call(${app}, stream(${JSON.stringify(await preferenceCallOf(notes.release, "get", {}))}))`,
        update: `env.apps.call(${app}, stream(${JSON.stringify(await preferenceCallOf(notes.release, "update", update))}))`,
        // The update, named a query so a read permission would let it by.
        disguised: `env.apps.call(${app}, stream(${JSON.stringify(await preferenceCallOf(notes.release, "update", update, "query"))}))`,
      };

      const reading = await run(notes, tryEach(calls), ["read"]);
      expect({
        get: reading.get,
        update: reading.update,
        disguised: z
          .object({ error: z.object({ code: z.string() }) })
          .parse(reading.disguised).error.code,
      }).toStrictEqual({
        get: { ok: true, value: { compact: false, _rev: 0 } },
        update: "permission.denied",
        disguised: "operation.kind_mismatch",
      });

      const writing = await run(notes, tryEach({ update: calls.update }), [
        "read",
        "write",
      ]);
      expect(writing.update).toStrictEqual({
        ok: true,
        value: { compact: true, _rev: 1 },
      });
    });

    it("calls nothing without a permission of the agent's own", async () => {
      const notes = await notesApp();
      const app = JSON.stringify(notes.app);
      const titles = JSON.stringify(callOf(notes.release, "notes.titles", {}));
      const result = await run(
        notes,
        tryEach({ titles: `env.apps.call(${app}, stream(${titles}))` }),
        []
      );
      expect(result.titles).toBe("permission.denied");
    });

    it("restricts the App before a restricted chat writes to it, not when it only reads", async () => {
      const notes = await notesApp();
      const app = JSON.stringify(notes.app);
      const titles = JSON.stringify(callOf(notes.release, "notes.titles", {}));
      const reading = await runIn(
        notes,
        tryEach({ titles: `env.apps.call(${app}, stream(${titles}))` }),
        ["read", "write"],
        { before: restricted }
      );
      await expect(reading.returned()).resolves.toMatchObject({
        titles: {
          ok: true,
          value: [],
        },
      });
      await expect(
        appHost(env, appIdSchema.parse(notes.app)).isRestricted()
      ).resolves.toBeFalsy();

      const create = JSON.stringify(
        callOf(notes.release, "notes.create", { title: "Restricted" })
      );
      const writing = await runIn(
        notes,
        tryEach({ create: `env.apps.call(${app}, stream(${create}))` }),
        ["read", "write"],
        { before: restricted }
      );
      await expect(writing.returned()).resolves.toMatchObject({
        create: { ok: true },
      });
      await expect(
        appHost(env, appIdSchema.parse(notes.app)).isRestricted()
      ).resolves.toBeTruthy();
    });

    it("restricts the chat before a restricted App's answer reaches it", async () => {
      const notes = await notesApp();
      const other = await notesApp(notes.builder);
      await appHost(env, appIdSchema.parse(notes.app)).restrict();
      const app = JSON.stringify(notes.app);
      const titles = JSON.stringify(callOf(notes.release, "notes.titles", {}));
      const write = JSON.stringify(
        callOf(other.release, "notes.create", { title: "After" })
      );
      // Right after the answer, the code writes to another App: a write
      // from a restricted chat restricts that App, so it is restricted
      // only if the chat already was when the answer came back.
      const { returned: result } = await runIn(
        notes,
        tryEach({
          titles: `env.apps.call(${app}, stream(${titles}))`,
          write: `env.apps.call(${JSON.stringify(other.app)}, stream(${write}))`,
        }),
        ["read"],
        {
          alsoGrant: [
            {
              object: { type: "app", appId: other.app },
              actions: ["read", "write"],
              binding: "OTHER",
            },
          ],
        }
      );
      await expect(result()).resolves.toMatchObject({
        titles: { ok: true, value: [] },
        write: { ok: true },
      });
      await expect(
        appHost(env, appIdSchema.parse(other.app)).isRestricted()
      ).resolves.toBeTruthy();
    });

    it("stops a running call's commit once its write grant is revoked", async () => {
      const notes = await notesApp();
      const app = JSON.stringify(notes.app);
      const held = JSON.stringify(
        callOf(notes.release, "notes.holdThenCreate", { title: "Too late" })
      );
      const admin = await signedInApi(idp, "admin");
      const { chat } = await runIn(
        notes,
        tryEach({ held: `env.apps.call(${app}, stream(${held}))` }),
        ["read", "write"],
        {
          during: async (_chat, [grant]) => {
            await untilNoted(notes, "started");
            await admin.api.permissions.revoke(grant ?? "");
            await noteAs(notes, "go");
          },
        }
      );
      // Once the call is recorded, the action's write was tried and
      // settled: it never committed.
      await settled(chat);
      await expect(titlesOf(notes)).resolves.toStrictEqual({
        ok: true,
        value: ["started", "go"],
      });
    });

    it("stops a running call's commit once its code run closes, its grant still held", async () => {
      const notes = await notesApp();
      const other = await notesApp(notes.builder);
      const app = JSON.stringify(notes.app);
      const held = JSON.stringify(
        callOf(notes.release, "notes.holdThenCreate", { title: "Too late" })
      );
      const admin = await signedInApi(idp, "admin");
      const { chat } = await runIn(
        notes,
        tryEach({ held: `env.apps.call(${app}, stream(${held}))` }),
        ["read", "write"],
        {
          alsoGrant: [
            {
              object: { type: "app", appId: other.app },
              actions: ["read"],
              binding: "OTHER",
            },
          ],
          // Another of the agent's grants revoked closes the run (agent-
          // scope.ts); the App's write grant stays.
          during: async (_chat, [, otherGrant]) => {
            await untilNoted(notes, "started");
            await admin.api.permissions.revoke(otherGrant ?? "");
            await noteAs(notes, "go");
          },
        }
      );
      await settled(chat);
      await expect(titlesOf(notes)).resolves.toStrictEqual({
        ok: true,
        value: ["started", "go"],
      });
    });

    it("lets a restricted chat restrict only an App its person has a role in", async () => {
      const notes = await notesApp();
      const stranger = await signedInApi(idp, "builder");
      const app = JSON.stringify(notes.app);
      const create = JSON.stringify(
        callOf(notes.release, "notes.create", { title: "Stranger" })
      );
      const { returned: result } = await runIn(
        notes,
        tryEach({ create: `env.apps.call(${app}, stream(${create}))` }),
        ["read", "write"],
        { personId: stranger.userId, before: restricted }
      );
      await expect(result()).resolves.toMatchObject({
        create: "app.not_found",
      });
      await expect(
        appHost(env, appIdSchema.parse(notes.app)).isRestricted()
      ).resolves.toBeFalsy();
      await expect(titlesOf(notes)).resolves.toStrictEqual({
        ok: true,
        value: [],
      });
    });

    it("audits a call refused as data as refused, with its code", async () => {
      const notes = await notesApp();
      const app = JSON.stringify(notes.app);
      const invalid = JSON.stringify(
        callOf(notes.release, "notes.create", { title: "" })
      );
      const { chat, returned: result } = await runIn(
        notes,
        tryEach({ invalid: `env.apps.call(${app}, stream(${invalid}))` }),
        ["read", "write"]
      );
      await expect(result()).resolves.toMatchObject({
        invalid: { ok: false, error: { code: "contract.invalid_args" } },
      });
      await expect(appCalls(chat)).resolves.toStrictEqual([
        { outcome: "refused", reason: "contract.invalid_args" },
      ]);
    });

    it("refuses a stream that never ends within its time, and audits every refusal", async () => {
      const notes = await notesApp();
      const app = JSON.stringify(notes.app);
      const { chat, returned: result } = await runIn(
        notes,
        tryEach({
          stalled: `env.apps.call(${app}, new ReadableStream({ start() {} }))`,
        }),
        ["read"]
      );
      await expect(result()).resolves.toMatchObject({
        stalled: "operation.deadline_exceeded",
      });
      const denied = await runIn(
        notes,
        tryEach({
          titles: `env.apps.call(${app}, stream(${JSON.stringify(callOf(notes.release, "notes.titles", {}))}))`,
        }),
        []
      );
      await expect(denied.returned()).resolves.toMatchObject({
        titles: "permission.denied",
      });
      await expect(appCalls(chat)).resolves.toStrictEqual([
        { outcome: "refused", reason: "operation.deadline_exceeded" },
      ]);
      await expect(appCalls(denied.chat)).resolves.toStrictEqual([
        { outcome: "refused", reason: "permission.denied" },
      ]);
    });

    it("takes the request only as a stream, and reads it no further than a request may be", async () => {
      const notes = await notesApp();
      const app = JSON.stringify(notes.app);
      const titles = callOf(notes.release, "notes.titles", {});
      const padded = JSON.stringify(
        titles.replace("{", `{${" ".repeat(functionRequestMaxBytes)}`)
      );
      const result = await run(
        notes,
        tryEach({
          text: `env.apps.call(${app}, ${JSON.stringify(titles)})`,
          padded: `env.apps.call(${app}, stream(${padded}))`,
        }),
        ["read", "write"]
      );
      expect(result).toStrictEqual({
        text: "contract.invalid_request",
        padded: "contract.input_too_large",
      });
    });
  }
);
