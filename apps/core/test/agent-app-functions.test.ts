import { appIdSchema } from "@grasp-os/shared/ids";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
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

/** Waits, then writes: long enough for a grant to be revoked meanwhile. */
export const slowCreate = action({
  args: { title: v.string().min(1).max(200) },
  returns: v.null(),
  uses: [create],
  handler: async (ctx, args) => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await ctx.runMutation(create, args);
    return null;
  },
});

export const titles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).map((note) => note.title),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { create, slowCreate, titles } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "appMembers", write: "appMembers" } } },
  operations: { notes: { create, slowCreate, titles } },
  internalOperations: {},
  screens: [],
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
const notesApp = async () => {
  const builder = await signedInApi(idp, "builder");
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
  /** Before the chat asks, once the grant is made. */
  before?: (chat: Chat) => Promise<void>;
  /** While the chat's turn runs, given the grant's ID. */
  during?: (chat: Chat, grant: string | undefined) => Promise<void>;
}

/** Asks a chat of the builder's to run `code`, with the agent granted `actions` on the App. */
const runIn = async (
  { builder, app }: Awaited<ReturnType<typeof notesApp>>,
  code: string,
  actions: ("read" | "write")[],
  { before, during }: RunOptions = {}
) => {
  const chat = await chatOf(builder.userId, codeStep(code), says("Done."));
  const grant =
    actions.length > 0
      ? await requestGranted(idp, builder, {
          subject: chat.agent,
          object: { type: "app", appId: app },
          actions,
          binding: "NOTES",
        })
      : undefined;
  await before?.(chat);
  await Promise.all([chat.ask("Use the Notes App."), during?.(chat, grant)]);
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
      await appHost(env, appIdSchema.parse(notes.app)).restrict();
      const app = JSON.stringify(notes.app);
      const titles = JSON.stringify(callOf(notes.release, "notes.titles", {}));
      // The code asks, inside its own call, whether its chat is restricted
      // once the answer is in hand: it must already be.
      const { chat, returned: result } = await runIn(
        notes,
        tryEach({ titles: `env.apps.call(${app}, stream(${titles}))` }),
        ["read"]
      );
      await expect(result()).resolves.toMatchObject({
        titles: { ok: true, value: [] },
      });
      await expect(
        chat.stub.isChatRestricted(chat.chat.id)
      ).resolves.toBeTruthy();
    });

    it("stops a running call's commit once its write grant is revoked", async () => {
      const notes = await notesApp();
      const app = JSON.stringify(notes.app);
      const slow = JSON.stringify(
        callOf(notes.release, "notes.slowCreate", { title: "Too late" })
      );
      const admin = await signedInApi(idp, "admin");
      await runIn(
        notes,
        tryEach({ slow: `env.apps.call(${app}, stream(${slow}))` }),
        ["read", "write"],
        {
          during: async (_chat, grant) => {
            await scheduler.wait(800);
            await admin.api.permissions.revoke(grant ?? "");
          },
        }
      );
      // The revocation also closes the code run (agent-scope.ts), so its
      // step ends refused: what counts is that the commit never landed.
      await expect(titlesOf(notes)).resolves.toStrictEqual({
        ok: true,
        value: [],
      });
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
