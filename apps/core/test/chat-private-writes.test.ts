import { personalBrainOf } from "@grasp-os/brain-next/contract";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { addSource } from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import {
  codeResults,
  codeStep,
  model,
  personalChatsOf,
  says,
  toolStep,
} from "./agent-chat.ts";
import { testApp } from "./app-definitions.ts";
import { commitApp, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { saveInstructions } from "./instruction-saves.ts";
import { mailConnection, mailWithSearch } from "./mail-connection.ts";
import type { ProviderReply } from "./model-provider.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// What a chat writes for others once it used something only its person
// may read (GRA-1843, private-reads.ts, held-app-calls.ts), through real
// turns: the Workspace, its ChatSession, the code's isolates, the
// gateway, connect, the Brain and the App's sealed release are real; the
// model provider is the fake behind connect. From the threat model on the
// issue: a write that takes the person's own content where an App's
// members read it without them; the content read in one turn and written
// in a later one; a confirmation of something other than what was shown,
// replayed, or given by someone else; a write to their own space stopped;
// a turn that read nothing of theirs, or that nobody started, held.

const idp = mockIdp();

/** Signing people in and whole turns take a while on CI. */
const slow = { timeout: 120_000 };

const notesFiles = testApp(
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
import { mutation, query } from "@server/_generated/server";

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
  }
);

/** A word no other test's sources hold: letters only. */
const word = () =>
  `zq${crypto
    .randomUUID()
    .replaceAll(/[^a-f]/gu, "")
    .slice(0, 12)}`;

/** The call of `path` with `input`, as the chat's code writes it. */
const callOf = (release: Release, path: string, input: unknown): string =>
  JSON.stringify({
    reference: { name: path, kind: release.app.functions[path]?.kind },
    args: input,
  });

/**
 * A builder's Notes App, live, and a chat of theirs in their own
 * Workspace whose agent may write to it and holds the `brain` grant,
 * answered by what `replies` makes of the App.
 */
const notesChat = async (
  replies: (app: string, release: Release) => ProviderReply[]
) => {
  const builder = await signedInApi(idp, "builder");
  const admin = await signedInApi(idp, "admin");
  const { id: app } = await builder.api.apps.create({ name: "Notes" });
  const { version } = await commitApp(builder.api, app, notesFiles);
  await builder.api.versions.rollback({ kind: "app", id: app }, version);
  const release = await loadRelease(env, app, version);
  const chats = await personalChatsOf(builder.userId, ...replies(app, release));
  await requestGranted(idp, builder, {
    subject: chats.agent,
    object: { type: "app", appId: app },
    actions: ["read", "write"],
    binding: "NOTES",
  });
  await requestGranted(idp, admin, {
    subject: chats.agent,
    object: { type: "platform" },
    actions: ["brain"],
    binding: "BRAIN",
  });
  const { chat, ask } = await chats.newChat();
  /** The App's notes, as its builder's page reads them. */
  const titles = async (): Promise<string[]> => {
    const { result } = await callAppFunction(
      env,
      { userId: builder.userId, role: "builder", teams: [] },
      app,
      callOf(release, "notes.titles", {})
    );
    return z
      .object({ ok: z.literal(true), value: z.array(z.string()) })
      .parse(result).value;
  };
  return { builder, app, release, chats, chat, ask, titles };
};

/** Adds `text` to `personId`'s own store: readable by them alone. */
const ownSource = async (personId: string, text: string): Promise<void> => {
  await addSource(env, {
    source: { producer: "upload", id: crypto.randomUUID() },
    change: crypto.randomUUID(),
    text,
    readers: { kind: "owner", personId },
  });
};

/** A code step writing a note titled `title` to `app`: what the call answered. */
const writesNote = (app: string, release: Release, title: string) =>
  codeStep(
    `export default async (self, env) => {
      try {
        return await env.apps.call(${JSON.stringify(app)}, new Blob([${JSON.stringify(
          callOf(release, "notes.create", { title })
        )}]).stream());
      } catch (error) {
        return { refused: error.code ?? error.message };
      }
    };`
  );

const answeredSchema = z.union([
  z.object({ held: z.object({ id: z.uuid(), expiresAt: z.string() }) }),
  z.object({
    result: z.union([
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
    ]),
  }),
  z.object({ refused: z.string() }),
]);

/** What each code step of the chat answered, in order. */
const answers = async (
  stub: Awaited<ReturnType<typeof notesChat>>["chats"]["stub"],
  chatId: string
) => {
  const results = await codeResults(stub, chatId);
  return results.map(({ text }) => {
    const answered = answeredSchema.parse(
      JSON.parse(text.replace("Returned:\n", ""))
    );
    if ("held" in answered) {
      return "held";
    }
    if ("refused" in answered) {
      return answered.refused;
    }
    return answered.result.ok ? "written" : answered.result.error.code;
  });
};

/** The events of `action` about chat `chatId`, once delivered. */
const eventsOf = async (action: string, chatId: string, count: number) =>
  await vi.waitFor(
    async () => {
      const logged = await allEvents();
      const events = logged.filter(
        (event) =>
          event.action === action &&
          (event.target?.id === chatId || event.detail.chat === chatId)
      );
      expect(events).toHaveLength(count);
      return events;
    },
    { timeout: 10_000, interval: 100 }
  );

describe("what a chat writes for others once it used something only its person may read", () => {
  it(
    "holds a write to an App after recalling the person's own source, runs exactly that request once when they confirm it, and still writes to their own space",
    slow,
    async () => {
      const depot = word();
      const marker = `own-${unique()}`;
      // The turn: it remembers the person's own word (their own space),
      // then writes the note (where the App's members read).
      const notes = await notesChat((app, release) => [
        toolStep("remember", {
          about: "me",
          attribute: "preference",
          value: "Dutch",
          type: "preference",
          statement: "Wants answers in Dutch",
          quote: "always want answers in Dutch",
        }),
        says(JSON.stringify({ theirs: true })),
        writesNote(app, release, marker),
        says("It waits for you."),
      ]);
      const { builder, app, release, chats, chat, ask, titles } = notes;
      await ownSource(builder.userId, `Depot ${depot} opens at seven.`);
      const said = `When does depot ${depot} open? I always want answers in Dutch.`;
      await ask(said);
      const someone = await signedInApi(idp, "builder");
      const [held] = await builder.api.chats.heldCalls(chat.id);
      const request = callOf(release, "notes.create", { title: marker });
      const before = await titles();
      const tries = {
        someoneElse: await outcome(
          someone.api.chats.confirmHeldCall(
            chat.id,
            held?.id ?? "",
            held?.requestHash ?? ""
          )
        ),
        anotherRequest: await outcome(
          builder.api.chats.confirmHeldCall(
            chat.id,
            held?.id ?? "",
            await sha256Hex(
              callOf(release, "notes.create", { title: "Something else" })
            )
          )
        ),
      };
      const afterTries = await titles();
      const confirmed = await outcome(
        builder.api.chats.confirmHeldCall(
          chat.id,
          held?.id ?? "",
          held?.requestHash ?? ""
        )
      );
      const replayed = await outcome(
        builder.api.chats.confirmHeldCall(
          chat.id,
          held?.id ?? "",
          held?.requestHash ?? ""
        )
      );
      const own = personalBrainOf(
        inJurisdiction(env, env.BRAIN_STORE),
        builder.userId
      );
      const kept = await own.findEntities({
        reader: { person: builder.userId, groups: [] },
        identifier: { type: "ref", value: `grasp:person:${builder.userId}` },
      });

      expect({
        answers: await answers(chats.stub, chat.id),
        held: {
          function: held?.function,
          kind: held?.kind,
          appId: held?.appId,
          request: held?.request,
          requestHash: held?.requestHash,
        },
        before,
        tries,
        afterTries,
        confirmed,
        replayed,
        after: await titles(),
        waiting: await builder.api.chats.heldCalls(chat.id),
        // Their own memory was kept without a question.
        remembered: kept.entities.length > 0,
      }).toStrictEqual({
        answers: ["held"],
        held: {
          function: "notes.create",
          kind: "mutation",
          appId: app,
          request,
          requestHash: await sha256Hex(request),
        },
        before: [],
        tries: {
          // Not their chat: as if there were none.
          someoneElse: "agent.chat_not_found",
          anotherRequest: "agent.held_call_not_found",
        },
        afterTries: [],
        confirmed: "ok",
        replayed: "agent.held_call_not_found",
        after: [marker],
        waiting: [],
        remembered: true,
      });
      // Marked once, held once, confirmed once, each recorded.
      await eventsOf("chat.private_read", chat.id, 1);
      await eventsOf("chat.app_call.held", chat.id, 1);
      await eventsOf("chat.app_call.confirmed", chat.id, 1);
    }
  );

  it(
    "writes at once while the chat read nothing of the person's own, and holds every write after a turn that did, also from a turn that recalls nothing",
    slow,
    async () => {
      const depot = word();
      const first = `first-${unique()}`;
      const later = `later-${unique()}`;
      const notes = await notesChat((app, release) => [
        writesNote(app, release, first),
        says("Written."),
        says("Seven."),
        writesNote(app, release, later),
        says("It waits for you."),
      ]);
      const { builder, chats, chat, ask, titles } = notes;
      await ownSource(builder.userId, `Depot ${depot} opens at seven.`);
      // Finds nothing of theirs: written at once.
      await ask(`Add a note about the ${word()} keys.`);
      const unmarked = await titles();
      // Recalls their own source, writes nothing.
      await ask(`When does depot ${depot} open?`);
      // Recalls nothing, and writes what the model may still hold.
      await ask(`Add a note about the ${word()} locks.`);
      const [held] = await builder.api.chats.heldCalls(chat.id);
      const declined = await outcome(
        builder.api.chats.declineHeldCall(chat.id, held?.id ?? "")
      );
      const confirmedAfter = await outcome(
        builder.api.chats.confirmHeldCall(
          chat.id,
          held?.id ?? "",
          held?.requestHash ?? ""
        )
      );

      expect({
        answers: await answers(chats.stub, chat.id),
        unmarked,
        declined,
        confirmedAfter,
        after: await titles(),
      }).toStrictEqual({
        answers: ["written", "held"],
        unmarked: [first],
        declined: "ok",
        confirmedAfter: "agent.held_call_not_found",
        // Declined: never written.
        after: [first],
      });
    }
  );

  it(
    "is marked by the person's own instruction file in the turn, and by a file they attached once a code step reads it, in that same step",
    slow,
    async () => {
      const fromFile = await notesChat((app, release) => [
        codeStep(
          `export default async (self, env) => {
            const [file] = await env.chat.files();
            await env.chat.readFile(file.id);
            return await env.apps.call(${JSON.stringify(app)}, new Blob([${JSON.stringify(
              callOf(release, "notes.create", { title: "From the file" })
            )}]).stream());
          };`
        ),
        says("It waits for you."),
      ]);
      const file = await fromFile.builder.api.chats.attachFile(
        fromFile.chat.id,
        {
          name: "notes.md",
          bytes: new TextEncoder().encode(`# Mine ${unique()}`),
        }
      );
      await fromFile.chats.stub.ask(fromFile.chat.id, {
        text: `Note what my ${word()} file says.`,
        model,
        files: [file.id],
      });
      const fromInstructions = await notesChat((app, release) => [
        writesNote(app, release, `told-${unique()}`),
        says("It waits for you."),
      ]);
      await saveInstructions(
        fromInstructions.builder.api,
        { scope: "person", personId: fromInstructions.builder.userId },
        `Call me ${unique()}.`
      );
      await fromInstructions.ask(`Add a note about the ${word()} keys.`);

      expect({
        file: await answers(fromFile.chats.stub, fromFile.chat.id),
        fileTitles: await fromFile.titles(),
        instructions: await answers(
          fromInstructions.chats.stub,
          fromInstructions.chat.id
        ),
        instructionsTitles: await fromInstructions.titles(),
      }).toStrictEqual({
        file: ["held"],
        fileTitles: [],
        instructions: ["held"],
        instructionsTitles: [],
      });
    }
  );

  it(
    "leaves a turn nobody started as it was: it recalls nothing of the person's own, so the chat stays unmarked",
    slow,
    async () => {
      const depot = word();
      const later = `later-${unique()}`;
      const notes = await notesChat((app, release) => [
        writesNote(app, release, `woken-${unique()}`),
        says("Nothing to do."),
        writesNote(app, release, later),
        says("Written."),
      ]);
      const { builder, chats, chat, ask, titles } = notes;
      await ownSource(builder.userId, `Depot ${depot} opens at seven.`);
      await chats.stub.askUnattended(chat.id, {
        text: `When does depot ${depot} open?`,
        model,
      });
      await ask(`Add a note about the ${word()} keys.`);

      expect({
        answers: await answers(chats.stub, chat.id),
        held: await builder.api.chats.heldCalls(chat.id),
        after: await titles(),
      }).toStrictEqual({
        // A write in a turn nobody started is refused, as before.
        answers: ["agent.unattended", "written"],
        held: [],
        after: [later],
      });
    }
  );

  it(
    "refuses asking for a shared connection once the chat recalled the person's own source, as admins read why",
    slow,
    async () => {
      const depot = word();
      const shared = await mailConnection([], mailWithSearch);
      const asks = (binding: string) =>
        codeStep(
          `export default async (self, env) => { try { return (await env.connections.request(${JSON.stringify(
            {
              connectionId: shared.id,
              actions: ["mail.search"],
              binding,
              reason: "To find the invoice.",
            }
          )})).binding; } catch (error) { return { refused: error.code ?? error.message }; } };`
        );
      const notes = await notesChat(() => [
        asks("BEFORE"),
        says("Asked."),
        asks("AFTER"),
        says("Refused."),
      ]);
      const { builder, chats, chat, ask } = notes;
      await ownSource(builder.userId, `Depot ${depot} opens at seven.`);
      await ask(`Find the ${word()} invoice.`);
      await ask(`When does depot ${depot} open? Find its invoice.`);

      const results = await codeResults(chats.stub, chat.id);
      const requests = await builder.api.chats.connectionRequests(chat.id);

      expect({
        results: results.map(({ text }) => text.replace("Returned:\n", "")),
        requests: requests.map(({ binding }) => binding),
      }).toStrictEqual({
        results: [
          "BEFORE",
          JSON.stringify({ refused: "agent.private_shared_request" }),
        ],
        requests: ["BEFORE"],
      });
    }
  );
});
