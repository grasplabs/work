import { personalBrainOf } from "@grasp-os/brain-next/contract";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { addSource } from "../src/brain-next.ts";
import { appHost, inJurisdiction } from "../src/durable-objects.ts";
import { heldStartMs } from "../src/held-starts.ts";
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
import { leave } from "./runs.ts";
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
 * A builder's Notes App, live, and a chat in its own Workspace whose
 * agent may write to it and holds the `brain` grant, answered by what
 * `replies` makes of the App: the builder's chat, or with `asMember` the
 * chat of a member the builder added to the App as a user.
 */
const notesChat = async (
  replies: (app: string, release: Release) => ProviderReply[],
  { asMember = false }: { asMember?: boolean } = {}
) => {
  const builder = await signedInApi(idp, "builder");
  const admin = await signedInApi(idp, "admin");
  const { id: app } = await builder.api.apps.create({ name: "Notes" });
  const { version } = await commitApp(builder.api, app, notesFiles);
  await builder.api.versions.rollback({ kind: "app", id: app }, version);
  const release = await loadRelease(env, app, version);
  const person = asMember ? await signedInApi(idp, "user") : builder;
  if (asMember) {
    await builder.api.apps.members.add(app, {
      type: "person",
      id: person.userId,
      role: "user",
    });
  }
  const chats = await personalChatsOf(person.userId, ...replies(app, release));
  const grant = await requestGranted(idp, builder, {
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
  return {
    builder,
    admin,
    person,
    grant,
    app,
    release,
    chats,
    chat,
    ask,
    titles,
  };
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

/**
 * A note titled `title` held for its person, in a chat that recalled their
 * own source (`notesChat`'s options apply), and the hold as their page
 * lists it.
 */
const heldNote = async (options: { asMember?: boolean } = {}) => {
  const depot = word();
  const title = `held-${unique()}`;
  const notes = await notesChat(
    (app, release) => [
      writesNote(app, release, title),
      says("It waits for you."),
    ],
    options
  );
  await ownSource(notes.person.userId, `Depot ${depot} opens at seven.`);
  await notes.ask(`When does depot ${depot} open? Note it.`);
  const [held] = await notes.person.api.chats.heldCalls(notes.chat.id);
  if (held === undefined) {
    throw new Error("Nothing was held");
  }
  return { ...notes, held, title };
};

/** `notes`' person confirming `held`, exactly as it was shown to them: how it went. */
const confirmedAsShown = async ({
  person,
  chat,
  held,
}: Awaited<ReturnType<typeof heldNote>>) =>
  await outcome(
    person.api.chats.confirmHeldCall(chat.id, held.id, held.requestHash)
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
      const heldId = held?.id ?? "";
      const hash = held?.requestHash ?? "";
      /** `who` confirming the held call for the request of `requestHash`. */
      const confirms = async (
        who: Awaited<ReturnType<typeof signedInApi>>,
        requestHash: string
      ) =>
        await outcome(
          who.api.chats.confirmHeldCall(chat.id, heldId, requestHash)
        );
      const before = await titles();
      const tries = {
        someoneElse: await confirms(someone, hash),
        anotherRequest: await confirms(
          builder,
          await sha256Hex(
            callOf(release, "notes.create", { title: "Something else" })
          )
        ),
      };
      const afterTries = await titles();
      const confirmed = await confirms(builder, hash);
      const replayed = await confirms(builder, hash);
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
      const [ended] = await eventsOf("chat.app_call.ended", chat.id, 1);
      expect(ended?.detail.outcome).toBe("ok");
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
    "is not marked by what the person wrote or brought in themselves: their own instruction file, their own skill and a file they attached leave the write to run at once",
    slow,
    async () => {
      const title = `mine-${unique()}`;
      const skill = word();
      const notes = await notesChat((app, release) => [
        codeStep(
          `export default async (self, env) => {
            const [file] = await env.chat.files();
            await env.chat.readFile(file.id);
            await env.skills.read({ skill: { scope: "person", name: ${JSON.stringify(skill)}, version: 1 } });
            return await env.apps.call(${JSON.stringify(app)}, new Blob([${JSON.stringify(
              callOf(release, "notes.create", { title })
            )}]).stream());
          };`
        ),
        says("Written."),
      ]);
      const { person, chats, chat, titles } = notes;
      await saveInstructions(
        person.api,
        { scope: "person", personId: person.userId },
        `Call me ${unique()}.`
      );
      await person.api.skills.save(
        `---\nname: ${skill}\ndescription: How to note ${skill}\n---\nSteps for ${skill}`
      );
      const file = await person.api.chats.attachFile(chat.id, {
        name: "notes.md",
        bytes: new TextEncoder().encode(`# Mine ${unique()}`),
      });
      await chats.stub.ask(chat.id, {
        text: `Note what my ${word()} file says.`,
        model,
        files: [file.id],
      });

      expect({
        answers: await answers(chats.stub, chat.id),
        held: await person.api.chats.heldCalls(chat.id),
        after: await titles(),
      }).toStrictEqual({
        answers: ["written"],
        held: [],
        after: [title],
      });
    }
  );

  it(
    "is marked by an answer read through the person's own mailbox, in the same code step that writes, and not by one read through a shared connection",
    slow,
    async () => {
      const ownTitle = `own-mail-${unique()}`;
      const sharedTitle = `shared-mail-${unique()}`;
      /** A code step searching `binding`'s mail, then writing a note titled `title`. */
      const searchesThenWrites = (
        app: string,
        release: Release,
        binding: string,
        title: string
      ) =>
        codeStep(
          `export default async (self, env) => {
            await env.connections.call(${JSON.stringify(binding)}, "mail.search", { query: "invoice" });
            return await env.apps.call(${JSON.stringify(app)}, new Blob([${JSON.stringify(
              callOf(release, "notes.create", { title })
            )}]).stream());
          };`
        );
      // One chat at a time: the fake provider answers the last one made.
      const own = await notesChat((app, release) => [
        searchesThenWrites(app, release, "MYMAIL", ownTitle),
        says("It waits for you."),
      ]);
      const mine = await mailConnection([], mailWithSearch, {
        provider: "mail_own",
        owner: own.person.userId,
      });
      await requestGranted(idp, own.admin, {
        subject: own.chats.agent,
        object: { type: "connection", connectionId: mine.id },
        actions: ["mail.search"],
        binding: "MYMAIL",
      });
      await own.ask(`Find the ${word()} invoice and note it.`);
      const shared = await notesChat((app, release) => [
        searchesThenWrites(app, release, "MAIL", sharedTitle),
        says("Written."),
      ]);
      const company = await mailConnection([], mailWithSearch);
      await requestGranted(idp, shared.admin, {
        subject: shared.chats.agent,
        object: { type: "connection", connectionId: company.id },
        actions: ["mail.search"],
        binding: "MAIL",
      });
      await shared.ask(`Find the ${word()} invoice and note it.`);

      expect({
        own: await answers(own.chats.stub, own.chat.id),
        ownTitles: await own.titles(),
        shared: await answers(shared.chats.stub, shared.chat.id),
        sharedTitles: await shared.titles(),
      }).toStrictEqual({
        own: ["held"],
        ownTitles: [],
        shared: ["written"],
        sharedTitles: [sharedTitle],
      });
      await eventsOf("chat.private_read", own.chat.id, 1);
    }
  );

  it(
    "lets a hold lapse after a day: it is no longer listed or confirmable, its request is emptied and its end recorded",
    slow,
    async () => {
      const notes = await heldNote();
      const { person, chats, chat, held, titles } = notes;
      // Read a day and a moment later: the hold lapses on that read.
      const later = await chats.stub.heldAppCalls(
        chat.id,
        person.userId,
        Date.now() + heldStartMs + 1
      );
      const kept = await runInDurableObject(chats.stub, (_instance, state) =>
        state.storage.sql
          .exec<{
            status: string;
            request: string | null;
          }>("SELECT status, request FROM held_app_calls WHERE id = ?", held.id)
          .toArray()
      );

      expect({
        later,
        now: await person.api.chats.heldCalls(chat.id),
        confirmed: await confirmedAsShown(notes),
        kept,
        after: await titles(),
      }).toStrictEqual({
        later: [],
        now: [],
        confirmed: "agent.held_call_not_found",
        kept: [{ status: "lapsed", request: null }],
        after: [],
      });
      await eventsOf("chat.app_call.lapsed", chat.id, 1);
    }
  );

  it(
    "checks again at confirming whether the agent may still write, the person may still use the App, and is still a member: none of them runs",
    slow,
    async () => {
      const revoked = await heldNote();
      await revoked.admin.api.permissions.revoke(revoked.grant);
      const roleLost = await heldNote({ asMember: true });
      await roleLost.builder.api.apps.members.remove(roleLost.app, {
        type: "person",
        id: roleLost.person.userId,
      });
      const left = await heldNote();
      const comeBack = await leave(left.person.userId);
      try {
        expect({
          revoked: await confirmedAsShown(revoked),
          revokedTitles: await revoked.titles(),
          roleLost: await confirmedAsShown(roleLost),
          roleLostTitles: await roleLost.titles(),
          left: await confirmedAsShown(left),
          leftTitles: await left.titles(),
        }).toStrictEqual({
          revoked: "permission.denied",
          revokedTitles: [],
          // Answered as an App they can't see at all.
          roleLost: "app.not_found",
          roleLostTitles: [],
          left: "permission.person_inactive",
          leftTitles: [],
        });
      } finally {
        await comeBack();
      }
    }
  );

  it(
    "carries restricted mode both ways on a confirmed write, as on the agent's own: a restricted chat restricts the App, a restricted App the chat",
    slow,
    async () => {
      const fromChat = await heldNote();
      await fromChat.chats.stub.restrictChat(fromChat.chat.id);
      const fromApp = await heldNote();
      await appHost(env, fromApp.app).restrict();

      expect({
        fromChat: await confirmedAsShown(fromChat),
        appRestricted: await appHost(env, fromChat.app).isRestricted(),
        fromApp: await confirmedAsShown(fromApp),
        chatRestricted: await fromApp.chats.stub.isChatRestricted(
          fromApp.chat.id
        ),
      }).toStrictEqual({
        fromChat: "ok",
        appRestricted: true,
        fromApp: "ok",
        chatRestricted: true,
      });
    }
  );

  it(
    "takes exactly one of a confirm and a decline sent at once, and runs the write at most once",
    slow,
    async () => {
      const notes = await heldNote();
      const { person, chat, held, title, titles } = notes;
      const [confirm, decline] = await Promise.all([
        confirmedAsShown(notes),
        outcome(person.api.chats.declineHeldCall(chat.id, held.id)),
      ]);
      const after = await titles();

      expect([confirm, decline].filter((each) => each === "ok")).toStrictEqual([
        "ok",
      ]);
      expect([confirm, decline]).toContain("agent.held_call_not_found");
      expect(after).toStrictEqual(confirm === "ok" ? [title] : []);
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
