import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../../src/app-releases.ts";
import type { Release } from "../../src/app-releases.ts";
import { chatOf, codeResults, codeStep, says } from "../agent-chat.ts";
import { requestGranted } from "../apps.ts";
import { mockIdp } from "../idp.ts";
import { signedInApi } from "../sign-in.ts";

// `env.apps.call` in a chat's code on-prem: the code runs in a sandbox
// session, and each App function it calls in a child session of the run's,
// through core's real AppsApi (agent-apps.ts), with `SANDBOX_HOST` bound to
// the sandbox supervisor this project starts.

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

export const count = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).length,
});

/** Writes a note, then counts them: two functions nested in one. */
export const createAndCount = action({
  args: { title: v.string().min(1).max(200) },
  returns: v.number(),
  uses: [create, count],
  handler: async (ctx, args) => {
    await ctx.runMutation(create, args);
    return await ctx.runQuery(count, {});
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { count, create, createAndCount } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "appMembers", write: "appMembers" } } },
  operations: { notes: { count, create, createAndCount } },
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

/** A builder's Notes App, current, and the release that runs. */
const notesApp = async () => {
  const builder = await signedInApi(idp, "builder");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  const { version } = await builder.api.apps.files.commit(id, files, "First");
  await builder.api.apps.versions.setCurrent(id, version);
  return { builder, app: id, release: await loadRelease(env, id, version) };
};

/** What `code` returned, run by a chat of the builder's with write on the App. */
const run = async (
  { builder, app }: Awaited<ReturnType<typeof notesApp>>,
  code: string
): Promise<unknown> => {
  const chat = await chatOf(builder.userId, codeStep(code), says("Done."));
  await requestGranted(idp, builder, {
    subject: chat.agent,
    object: { type: "app", appId: app },
    actions: ["read", "write"],
    binding: "NOTES",
  });
  await chat.ask("Use the Notes App.");
  const [result] = await codeResults(chat.stub, chat.chat.id);
  return z
    .unknown()
    .parse(JSON.parse(result?.text.replace("Returned:\n", "") ?? "null"));
};

/** Code that runs `calls` (each a call's JSON), all at once, and returns their results. */
const allAtOnce = (calls: string[]): string =>
  `export default async (self, env) => {
    const calls = ${JSON.stringify(calls)};
    const answers = await Promise.all(calls.map((call) => env.apps.call(APP, new Blob([call]).stream())));
    return answers.map((answer) => answer.result);
  };`;

describe("a chat's App calls on-prem", () => {
  it("runs an App function a run calls, nesting two more, in a child of the run's session", async () => {
    const notes = await notesApp();
    const code = allAtOnce([
      callOf(notes.release, "notes.createAndCount", { title: "one" }),
    ]).replace("APP", JSON.stringify(notes.app));
    await expect(run(notes, code)).resolves.toStrictEqual([
      { ok: true, value: 1 },
    ]);
  });

  it("runs a run's App calls made all at once, one after the other", async () => {
    const notes = await notesApp();
    const code = allAtOnce(
      ["a", "b", "c"].map((title) =>
        callOf(notes.release, "notes.create", { title })
      )
    ).replace("APP", JSON.stringify(notes.app));
    const results = z
      .array(z.object({ ok: z.boolean() }))
      .parse(await run(notes, code));
    expect(results.map(({ ok }) => ok)).toStrictEqual([true, true, true]);
  });

  it("refuses a run's calls past the eight it may have queued at once, as busy", async () => {
    const notes = await notesApp();
    const calls = Array.from({ length: 20 }, (_, index) =>
      callOf(notes.release, "notes.create", { title: `note ${index}` })
    );
    // Each call's outcome: its result, or why it was refused.
    const code = `export default async (self, env) => {
      const calls = ${JSON.stringify(calls)};
      const settled = await Promise.allSettled(calls.map((call) => env.apps.call(${JSON.stringify(notes.app)}, new Blob([call]).stream())));
      return settled.map((one) => one.status === "fulfilled" ? { ok: one.value.result.ok } : { refused: one.reason.message });
    };`;
    const outcomes = z
      .array(
        z.object({ ok: z.boolean() }).or(z.object({ refused: z.string() }))
      )
      .parse(await run(notes, code));
    const refused = outcomes.flatMap((outcome) =>
      "refused" in outcome ? [outcome.refused] : []
    );
    // The first eight queue, one taking its turn; the rest find it full.
    expect({
      ran: outcomes.length - refused.length >= 8,
      someRefused: refused.length > 0,
      why: [...new Set(refused)],
    }).toStrictEqual({
      ran: true,
      someRefused: true,
      why: [
        "This App runs as many calls at once as it may. Try again shortly.",
      ],
    });
  });
});
