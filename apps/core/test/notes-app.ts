import { env } from "cloudflare:workers";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { addSource } from "../src/brain-next.ts";
import { codeStep } from "./agent-chat.ts";
import { testApp } from "./app-definitions.ts";
import { commitApp } from "./apps.ts";
import type { signedInApi } from "./sign-in.ts";

// A Notes App, live, for the tests of what a chat writes to an App once it
// used something only its person may read (held-app-calls.ts): in Grasp's
// own chat (chat-private-writes.test.ts) and in a chat app's direct
// message (channels-held-app-writes.test.ts, channels-slack.test.ts).

export const notesFiles = testApp(
  {
    name: "Notes",
    tables: {
      notes: {
        fields: { title: "v.string().min(1).max(200)" },
        access: { read: "appMembers", write: "appMembers" },
      },
    },
  },
  {
    "server/notes.ts": `import { v } from "@grasp-os/sdk";
import { action, mutation, query } from "@server/_generated/server";

export const create = mutation({
  args: { title: v.string().min(1).max(200) },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

/** A note with a body it doesn't keep: a request as long as a test needs. */
export const createWith = mutation({
  args: { title: v.string().min(1).max(200), body: v.string().max(20000) },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", { title: args.title }),
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
  handler: async (ctx, args) => {
    await ctx.runMutation(create, { title: "started" });
    for (let polls = 0; polls < 100; polls += 1) {
      const seen = await ctx.runQuery(titles, {});
      if (seen.includes("go")) {
        await ctx.runMutation(create, args);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  },
});
`,
  }
);

/** A word no other test's sources hold: letters only. */
export const word = () =>
  `zq${crypto
    .randomUUID()
    .replaceAll(/[^a-f]/gu, "")
    .slice(0, 12)}`;

/** The call of `path` with `input`, as the chat's code writes it. */
export const callOf = (
  release: Release,
  path: string,
  input: unknown
): string =>
  JSON.stringify({
    reference: { name: path, kind: release.app.functions[path]?.kind },
    args: input,
  });

/** A Notes App of `builder`'s, live, and the release that runs. */
export const liveNotes = async (
  builder: Awaited<ReturnType<typeof signedInApi>>
) => {
  const { id: app } = await builder.api.apps.create({ name: "Notes" });
  const { version } = await commitApp(builder.api, app, notesFiles);
  await builder.api.versions.rollback({ kind: "app", id: app }, version);
  return { app, release: await loadRelease(env, app, version) };
};

/** Adds `text` to `personId`'s own store: readable by them alone. */
export const ownSource = async (
  personId: string,
  text: string
): Promise<void> => {
  await addSource(env, {
    source: { producer: "upload", id: crypto.randomUUID() },
    change: crypto.randomUUID(),
    text,
    readers: { kind: "owner", personId },
  });
};

/** A code step writing a note titled `title` to `app` (with `path`): what the call answered. */
export const writesNote = (
  app: string,
  release: Release,
  title: string,
  path = "notes.create"
) =>
  codeStep(
    `export default async (self, env) => {
      try {
        return await env.apps.call(${JSON.stringify(app)}, new Blob([${JSON.stringify(
          callOf(release, path, { title })
        )}]).stream());
      } catch (error) {
        return { refused: error.code ?? error.message, message: error.message };
      }
    };`
  );

/** The notes of `app` (running `release`), as its builder `builderId`'s page reads them. */
export const noteTitles = async (
  builderId: string,
  app: string,
  release: Release
): Promise<string[]> => {
  const { result } = await callAppFunction(
    env,
    { userId: builderId, role: "builder", teams: [] },
    app,
    callOf(release, "notes.titles", {})
  );
  return z
    .object({ ok: z.literal(true), value: z.array(z.string()) })
    .parse(result).value;
};

/**
 * A note's title holding what Teams, Slack and a page draw as nothing: a
 * payload of a byte a variation selector after a visible letter, a Hangul
 * filler, the grapheme joiner, tag characters, a bidi override and a
 * zero-width joiner; and an ordinary emoji with its variation selector.
 */
export const hiddenTitle =
  "A\u{E0101}\u{E0142}\u3164\u034F \u2764\uFE0F \u{E0041}\u{E0042}\u202Eevil\u200D!";

/** `hiddenTitle` as a person is shown it: every one an escape, the emoji's picture kept. */
export const hiddenTitleShown = String.raw`A\u{E0101}\u{E0142}\u{3164}\u{34F} ❤\u{FE0F} \u{E0041}\u{E0042}\u{202E}evil\u{200D}!`;
