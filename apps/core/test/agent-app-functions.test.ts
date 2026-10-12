import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
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
import { mutation, query } from "#grasp/server";

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
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { create, titles } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "appMembers", write: "appMembers" } } },
  operations: { notes: { create, titles } },
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
const run = async (
  { builder, app }: Awaited<ReturnType<typeof notesApp>>,
  code: string,
  actions: ("read" | "write")[]
) => {
  const chat = await chatOf(builder.userId, codeStep(code), says("Done."));
  if (actions.length > 0) {
    await requestGranted(idp, builder, {
      subject: chat.agent,
      object: { type: "app", appId: app },
      actions,
      binding: "NOTES",
    });
  }
  await chat.ask("Use the Notes App.");
  return await returned(chat);
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
