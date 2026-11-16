import { personalBrainOf, recallLimit } from "@grasp-os/brain-next/contract";
import { heldAppCallsPage } from "@grasp-os/shared/chat";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import type { Release } from "../src/app-releases.ts";
import type { RecalledItem } from "../src/brain-next.ts";
import {
  addSource,
  recallAs,
  recallOwnedAs,
  recalledTokens,
  rememberAs,
} from "../src/brain-next.ts";
import { appHost, inJurisdiction } from "../src/durable-objects.ts";
import { heldStartMs } from "../src/held-starts.ts";
import { turnRecallBudget } from "../src/turn-recall.ts";
import {
  codeResults,
  codeStep,
  model,
  personalChatsOf,
  says,
  toolStep,
} from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { saveInstructions } from "./instruction-saves.ts";
import { mailConnection, mailWithSearch } from "./mail-connection.ts";
import { fakeProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import {
  callOf,
  liveNotes,
  noteTitles,
  ownSource,
  word,
  writesNote,
} from "./notes-app.ts";
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

/**
 * A builder's Notes App, live, and a chat in its own Workspace whose
 * agent may write to it and holds the `brain` grant, answered by what
 * `replies` makes of the App: the builder's chat (`builder`'s, when
 * given), or with `asMember` the chat of a member the builder added to
 * the App as a user.
 */
const notesChat = async (
  replies: (app: string, release: Release) => ProviderReply[],
  {
    asMember = false,
    builder: given,
  }: {
    asMember?: boolean;
    builder?: Awaited<ReturnType<typeof signedInApi>>;
  } = {}
) => {
  const builder = given ?? (await signedInApi(idp, "builder"));
  const admin = await signedInApi(idp, "admin");
  const { app, release } = await liveNotes(builder);
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
  const titles = async (): Promise<string[]> =>
    await noteTitles(builder.userId, app, release);
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

/** Adds `text` to the shared store: readable by everyone. */
const sharedSource = async (text: string): Promise<void> => {
  await addSource(env, {
    source: { producer: "upload", id: crypto.randomUUID() },
    change: crypto.randomUUID(),
    text,
    readers: { kind: "everyone" },
  });
};

/** An item's citation and text. */
const keyOf = ({ source, version, position, text }: RecalledItem): string =>
  JSON.stringify([source, version, position, text]);

/** `items`' citations and texts in any order. */
const inAnyOrder = (items: readonly RecalledItem[]): string[] =>
  items.map((item) => keyOf(item)).toSorted();

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
const heldNote = async ({
  asMember = false,
  own = "source",
  path = "notes.create",
}: {
  asMember?: boolean;
  /** What of the person's own store the recall finds: a source, or a memory. */
  own?: "source" | "memory";
  /** The function the held call names. */
  path?: string;
} = {}) => {
  const depot = word();
  const title = `held-${unique()}`;
  const notes = await notesChat(
    (app, release) => [
      writesNote(app, release, title, path),
      says("It waits for you."),
    ],
    { asMember }
  );
  if (own === "source") {
    await ownSource(notes.person.userId, `Depot ${depot} opens at seven.`);
  } else {
    const statement = `Depot ${depot} opens at seven`;
    await rememberAs(env, notes.person.userId, {
      change: crypto.randomUUID(),
      about: { kind: "customer", names: [`Depot ${depot}`] },
      type: "fact",
      statement,
      quote: statement,
    });
  }
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

/** A code step reading `read`'s notes, then writing a note to the chat's own App. */
const copiesNotes =
  (read: Awaited<ReturnType<typeof liveNotes>>, title: string) =>
  (app: string, release: Release) => [
    codeStep(
      `export default async (self, env) => {
        await env.apps.call(${JSON.stringify(read.app)}, new Blob([${JSON.stringify(
          callOf(read.release, "notes.titles", {})
        )}]).stream());
        return await env.apps.call(${JSON.stringify(app)}, new Blob([${JSON.stringify(
          callOf(release, "notes.create", { title })
        )}]).stream());
      };`
    ),
    says("Done."),
  ];

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
      // Held once, by the agent's call that holds it, naming the hold.
      const logged = await allEvents();
      expect(
        logged.filter(
          ({ action, detail }) =>
            action === "agent.call" &&
            detail.method === "apps.call" &&
            detail.held === heldId
        )
      ).toHaveLength(1);
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
        "web",
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

  it(
    "is marked by an App's answer when the App may read through the person's own mailbox, and not when its connections are all shared",
    slow,
    async () => {
      const ownTitle = `inbox-${unique()}`;
      const plainTitle = `plain-${unique()}`;
      const builder = await signedInApi(idp, "builder");
      const inbox = await liveNotes(builder);
      const plain = await liveNotes(builder);
      const mine = await mailConnection([], mailWithSearch, {
        provider: "mail_own",
        owner: builder.userId,
      });
      const company = await mailConnection([], mailWithSearch);
      await requestGranted(idp, builder, {
        subject: { type: "app", appId: inbox.app },
        object: { type: "connection", connectionId: mine.id },
        actions: ["mail.search"],
        binding: "MAIL",
      });
      await requestGranted(idp, builder, {
        subject: { type: "app", appId: plain.app },
        object: { type: "connection", connectionId: company.id },
        actions: ["mail.search"],
        binding: "MAIL",
      });
      /** A chat of the builder's that may read `read`, asked to copy from it. */
      const copiesFrom = async (
        read: Awaited<ReturnType<typeof liveNotes>>,
        title: string
      ) => {
        // One chat at a time: the fake provider answers the last one made.
        const notes = await notesChat(copiesNotes(read, title), {
          builder,
        });
        await requestGranted(idp, builder, {
          subject: notes.chats.agent,
          object: { type: "app", appId: read.app },
          actions: ["read"],
          binding: "INBOX",
        });
        await notes.ask(`Copy the ${word()} note.`);
        return notes;
      };
      const own = await copiesFrom(inbox, ownTitle);
      const shared = await copiesFrom(plain, plainTitle);

      expect({
        own: await answers(own.chats.stub, own.chat.id),
        ownTitles: await own.titles(),
        shared: await answers(shared.chats.stub, shared.chat.id),
        sharedTitles: await shared.titles(),
      }).toStrictEqual({
        own: ["held"],
        ownTitles: [],
        shared: ["written"],
        sharedTitles: [plainTitle],
      });
    }
  );

  it(
    "holds a marked chat's write to an App in a chat app's direct message, for its card there alone: Grasp neither lists nor decides it, and nothing is written",
    slow,
    async () => {
      const depot = word();
      const title = `teams-${unique()}`;
      const notes = await notesChat((app, release) => [
        writesNote(app, release, title),
        says("It waits for you on the card."),
      ]);
      const { person, chats, titles } = notes;
      await ownSource(person.userId, `Depot ${depot} opens at seven.`);
      const { chatId } = await chats.stub.askThrough(
        person.userId,
        chats.agent.agentId,
        "teams",
        `When does depot ${depot} open? Note it.`,
        undefined,
        { kind: "direct" }
      );
      const [held] = await chats.stub.heldAppCalls(
        chatId,
        person.userId,
        "teams",
        Date.now()
      );

      const tries = {
        listed: await outcome(person.api.chats.heldCalls(chatId)),
        confirmed: await outcome(
          person.api.chats.confirmHeldCall(
            chatId,
            held?.id ?? "",
            held?.requestHash ?? ""
          )
        ),
        declined: await outcome(
          person.api.chats.declineHeldCall(chatId, held?.id ?? "")
        ),
      };
      const stillHeld = await chats.stub.heldAppCalls(
        chatId,
        person.userId,
        "teams",
        Date.now()
      );

      expect({
        answers: await answers(chats.stub, chatId),
        // A chat app's conversation is no chat in Grasp (GRA-1919): its
        // holds are listed and decided on its card alone.
        ...tries,
        stillHeld: stillHeld.map(({ id }) => id),
        after: await titles(),
      }).toStrictEqual({
        answers: ["held"],
        listed: "agent.chat_not_found",
        confirmed: "agent.chat_not_found",
        declined: "agent.chat_not_found",
        stillHeld: [held?.id],
        after: [],
      });
    }
  );

  it(
    "is marked by the answer of a write through the person's own mailbox they confirmed, read with `outcome`",
    slow,
    async () => {
      const title = `after-send-${unique()}`;
      const notes = await notesChat(() => [
        codeStep(
          `export default async (self, env) => await env.connections.call("MYMAIL", "mail.send", ${JSON.stringify(
            { to: "ben@acme.test", subject: "Invoice" }
          )});`
        ),
        says("It waits for you."),
      ]);
      const { admin, person, chats, chat, app, release, ask, titles } = notes;
      const mine = await mailConnection([], mailWithSearch, {
        provider: "mail_own",
        owner: person.userId,
      });
      await requestGranted(idp, admin, {
        subject: chats.agent,
        object: { type: "connection", connectionId: mine.id },
        actions: ["mail.send"],
        binding: "MYMAIL",
      });
      await ask("Send ben@acme.test the invoice.");
      const [sent] = await person.api.pendingActions.list();
      const confirmedSend = await outcome(
        person.api.pendingActions.confirm(sent?.id ?? "", sent?.inputHash ?? "")
      );
      await fakeProvider(
        codeStep(
          `export default async (self, env) => {
            await env.connections.outcome(${JSON.stringify(sent?.id ?? "")});
            return await env.apps.call(${JSON.stringify(app)}, new Blob([${JSON.stringify(
              callOf(release, "notes.create", { title })
            )}]).stream());
          };`
        ),
        says("It waits for you.")
      );
      await ask(`Note what became of the ${word()} invoice.`);
      const results = await codeResults(chats.stub, chat.id);

      expect({
        confirmedSend,
        last: answeredSchema.safeParse(
          JSON.parse(results.at(-1)?.text.replace("Returned:\n", "") ?? "{}")
        ).data,
        after: await titles(),
      }).toMatchObject({
        confirmedSend: "ok",
        last: { held: {} },
        after: [],
      });
    }
  );

  it(
    "is marked by a memory of the person's own store the recall hands over, not only a passage",
    slow,
    async () => {
      const notes = await heldNote({ own: "memory" });

      expect({
        held: notes.held.function,
        after: await notes.titles(),
      }).toStrictEqual({ held: "notes.create", after: [] });
    }
  );

  it(
    "records a confirmed write as done when it ran, though restricting the chat after it failed",
    slow,
    async () => {
      const notes = await heldNote({ path: "notes.holdThenCreate" });
      const { builder, chats, chat, app, release, title, titles } = notes;
      const confirming = confirmedAsShown(notes);
      // Running: the App says it started.
      await vi.waitFor(
        async () => {
          await expect(titles()).resolves.toContain("started");
        },
        { timeout: 20_000, interval: 100 }
      );
      // Restricting the chat after the call now fails: the App is
      // restricted, and the chat names another agent than the hold.
      await appHost(env, app).restrict();
      await runInDurableObject(chats.stub, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE chats SET agent_id = ? WHERE id = ?",
          crypto.randomUUID(),
          chat.id
        );
      });
      await callAppFunction(
        env,
        { userId: builder.userId, role: "builder", teams: [] },
        app,
        callOf(release, "notes.create", { title: "go" })
      );
      const confirmed = await confirming;
      const [ended] = await eventsOf("chat.app_call.ended", chat.id, 1);
      const after = await titles();

      expect({
        confirmed,
        ran: after.includes(title),
        ended: ended?.detail.outcome,
      }).toStrictEqual({
        confirmed: "permission.context_invalid",
        ran: true,
        ended: "ok",
      });
    }
  );

  it(
    "is marked by an App's answer when what the App may read can't be placed (a kind of source no longer served), and an already marked chat still holds its write after reading an App",
    slow,
    async () => {
      const builder = await signedInApi(idp, "builder");
      const unplaced = await liveNotes(builder);
      // A Knowledge collection grant left from before: unresolved.
      await env.DB.prepare(
        `INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id,
          actions, binding, status, requested_by, requested_at, granted_by, granted_at)
         VALUES (?, 'app', ?, 'collection', ?, '["read"]', ?, 'active', 'test', 0, 'test', 0)`
      )
        .bind(
          crypto.randomUUID(),
          unplaced.app,
          crypto.randomUUID(),
          `OLD_${unique().toUpperCase().replaceAll("-", "_")}`
        )
        .run();
      /** Reads `unplaced`'s notes, then writes `title` to the chat's own App. */
      const readsThenWrites =
        (title: string) => (app: string, release: Release) => [
          codeStep(
            `export default async (self, env) => {
              await env.apps.call(${JSON.stringify(unplaced.app)}, new Blob([${JSON.stringify(
                callOf(unplaced.release, "notes.titles", {})
              )}]).stream());
              return await env.apps.call(${JSON.stringify(app)}, new Blob([${JSON.stringify(
                callOf(release, "notes.create", { title })
              )}]).stream());
            };`
          ),
          says("Done."),
        ];
      const fresh = await notesChat(readsThenWrites(`unplaced-${unique()}`), {
        builder,
      });
      await requestGranted(idp, builder, {
        subject: fresh.chats.agent,
        object: { type: "app", appId: unplaced.app },
        actions: ["read"],
        binding: "OLD",
      });
      await fresh.ask(`Copy the ${word()} note.`);
      // Marked already (a recalled own source), then the same read and write.
      const depot = word();
      const marked = await notesChat(readsThenWrites(`marked-${unique()}`), {
        builder,
      });
      await requestGranted(idp, builder, {
        subject: marked.chats.agent,
        object: { type: "app", appId: unplaced.app },
        actions: ["read"],
        binding: "OLD",
      });
      await ownSource(builder.userId, `Depot ${depot} opens at seven.`);
      await marked.ask(`When does depot ${depot} open? Copy the note.`);

      expect({
        fresh: await answers(fresh.chats.stub, fresh.chat.id),
        freshTitles: await fresh.titles(),
        marked: await answers(marked.chats.stub, marked.chat.id),
        markedTitles: await marked.titles(),
      }).toStrictEqual({
        fresh: ["held"],
        freshTitles: [],
        marked: ["held"],
        markedTitles: [],
      });
    }
  );

  it("runs a hold confirmed twice at once exactly once", slow, async () => {
    const notes = await heldNote();
    const { title, titles } = notes;
    const tries = await Promise.all([
      confirmedAsShown(notes),
      confirmedAsShown(notes),
    ]);
    const after = await titles();

    expect({
      tries: tries.toSorted(),
      written: after.filter((each) => each === title),
    }).toStrictEqual({
      tries: ["agent.held_call_not_found", "ok"],
      written: [title],
    });
  });

  it(
    "lists every waiting hold of a chat, oldest first, page after page",
    slow,
    async () => {
      const notes = await heldNote();
      const { person, chats, chat, app, held } = notes;
      const now = Date.now();
      // More holds than a page, held after the first one, in order.
      const requests = Array.from(
        { length: heldAppCallsPage },
        (_, at) => `{"at":${at + 1}}`
      );
      const hashes = await Promise.all(
        requests.map(async (request) => await sha256Hex(request))
      );
      for (const [at, request] of requests.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- held one after another
        await chats.stub.holdAppCall(
          chat.id,
          person.userId,
          {
            agentId: chats.agent.agentId,
            appId: app,
            function: "notes.create",
            kind: "mutation",
            request,
            requestHash: hashes[at] ?? "",
          },
          now + at + 1
        );
      }
      const first = await person.api.chats.heldCalls(chat.id);
      const second = await person.api.chats.heldCalls(
        chat.id,
        first.at(-1)?.id
      );
      const ids = [...first, ...second].map(({ id }) => id);

      expect({
        first: first.length,
        second: second.length,
        once: new Set(ids).size,
        oldestFirst: ids[0] === held.id,
        lastHeld: second.at(-1)?.request,
      }).toStrictEqual({
        first: heldAppCallsPage,
        second: 1,
        once: heldAppCallsPage + 1,
        oldestFirst: true,
        lastHeld: `{"at":${heldAppCallsPage}}`,
      });
    }
  );

  it(
    "is marked when only the recall's second pass, for the analysis's words, finds the person's own source",
    slow,
    async () => {
      const depot = word();
      const title = `second-pass-${unique()}`;
      const notes = await notesChat((app, release) => [
        says("Hello."),
        writesNote(app, release, title),
        says("It waits for you."),
      ]);
      const { person, chats, chat, ask, titles } = notes;
      await ownSource(person.userId, `Depot ${depot} opens at seven.`);
      // A first message: nothing before it to resolve, no analysis.
      await ask(`Hello ${word()}.`);
      // The follow-up finds nothing (thin), so its analysis is waited for,
      // and its words alone find the person's own source.
      chats.provider.analysisReplies.push({
        text: JSON.stringify({ query: `When does depot ${depot} open?` }),
        inputTokens: 40,
        outputTokens: 10,
      });
      // No word of it is in the person's own source.
      await ask(`Who keeps the ${word()} keys? Note it.`);

      expect({
        answers: await answers(chats.stub, chat.id),
        after: await titles(),
      }).toStrictEqual({ answers: ["held"], after: [] });
      await eventsOf("chat.private_read", chat.id, 1);
    }
  );

  it(
    "counts the person's own store as used whenever its finding shaped the recall: an own match the budget cut entirely still marks",
    slow,
    async () => {
      const person = await signedInApi(idp, "user");
      const depot = word();
      await ownSource(
        person.userId,
        `Depot ${depot} opens at seven. ${"The depot keeps its keys in the back office behind the counter. ".repeat(40)}`
      );
      const { pack, fromOwn } = await recallOwnedAs(env, person.userId, {
        question: `When does depot ${depot} open?`,
        budget: { tokens: 1 },
        personal: true,
      });

      expect({
        items: pack.items.length,
        memories: pack.memories.length,
        // Found, though nothing of it fits: not reported as not found.
        depotNotFound: pack.notFound.includes(depot),
        fromOwn,
      }).toStrictEqual({
        items: 0,
        memories: 0,
        depotNotFound: false,
        fromOwn: true,
      });
    }
  );

  it(
    "marks when the person's own store changes only which words are said not found: the same items, the same cut",
    slow,
    async () => {
      const person = await signedInApi(idp, "user");
      const [depot, dock, own] = [word(), word(), word()];
      // More shared passages holding two of the question's words than a
      // way lists: the own passage, holding the third alone, ranks after
      // all of them and is never packed.
      for (let copy = 0; copy < recallLimit; copy += 1) {
        // oxlint-disable-next-line no-await-in-loop -- added one after another
        await sharedSource(`${depot} ${dock} ${word()}`);
      }
      await ownSource(person.userId, `${own} ${word()} ${word()}`);
      const question = `${depot} ${dock} ${own}`;
      const budget = { tokens: turnRecallBudget.tokens };
      const { pack, fromOwn } = await recallOwnedAs(env, person.userId, {
        question,
        budget,
        personal: true,
      });
      const shared = await recallAs(env, person.userId, {
        question,
        budget,
        personal: false,
      });

      expect({
        sameItems: pack.items,
        sameCut: pack.truncated,
        ownNotFound: pack.notFound.includes(own),
        sharedOwnNotFound: shared.notFound.includes(own),
        fromOwn,
      }).toStrictEqual({
        sameItems: shared.items,
        sameCut: shared.truncated,
        ownNotFound: false,
        sharedOwnNotFound: true,
        fromOwn: true,
      });
    }
  );

  it(
    "marks when the person's own store changes only whether the pack was cut short: the same items, the same words not found",
    slow,
    async () => {
      const person = await signedInApi(idp, "user");
      const [depot, dock] = [word(), word()];
      await sharedSource(`${depot} ${dock} ${word()}`);
      // Holds one of the two words: ranks after the shared passage.
      await ownSource(person.userId, `${depot} ${word()} ${word()}`);
      const question = `${depot} ${dock}`;
      const alone = await recallAs(env, person.userId, {
        question,
        budget: { tokens: turnRecallBudget.tokens },
        personal: false,
      });
      // Room for the shared passage alone.
      const budget = { tokens: recalledTokens(alone) };
      const { pack, fromOwn } = await recallOwnedAs(env, person.userId, {
        question,
        budget,
        personal: true,
      });
      const shared = await recallAs(env, person.userId, {
        question,
        budget,
        personal: false,
      });

      expect({
        sameItems: pack.items,
        sameNotFound: pack.notFound,
        truncated: pack.truncated,
        sharedTruncated: shared.truncated,
        fromOwn,
      }).toStrictEqual({
        sameItems: shared.items,
        sameNotFound: shared.notFound,
        truncated: true,
        sharedTruncated: false,
        fromOwn: true,
      });
    }
  );

  it(
    "marks when the person's own store changes only the order of the same items: an own passage the budget leaves out still takes a rank",
    slow,
    async () => {
      const person = await signedInApi(idp, "user");
      const [one, two, three, first, second] = [
        word(),
        word(),
        word(),
        word(),
        word(),
      ];
      const telling = `${one} ${two} ${three}`;
      // By words: the shortest passage holding the three words first, then
      // more of them, as many as a way lists, so the quoted phrase's
      // passages, holding fewer words, are listed only by the phrase:
      // the shorter first, the longer second.
      await sharedSource(telling);
      for (let copy = 1; copy < recallLimit; copy += 1) {
        // oxlint-disable-next-line no-await-in-loop -- added one after another
        await sharedSource(`${telling} ${word()} ${word()}`);
      }
      await sharedSource(`${first} ${second}`);
      await sharedSource(`${first} ${second} ${word()}`);
      // Holds the three words and the question's stop word: first by
      // words, and too long for what the budget leaves when its turn comes.
      await ownSource(
        person.userId,
        `The ${telling} ${Array.from({ length: 40 }, () => word()).join(" ")}`
      );
      const question = `The ${telling} "${first} ${second}"`;
      const alone = await recallAs(env, person.userId, {
        question,
        budget: { tokens: turnRecallBudget.tokens },
        personal: false,
      });
      // Room for the phrase's shorter passage, the shortest by words and
      // the phrase's longer passage, the first three alone would hand over.
      const budget = {
        tokens: recalledTokens({ ...alone, items: alone.items.slice(0, 3) }),
      };
      const { pack, fromOwn } = await recallOwnedAs(env, person.userId, {
        question,
        budget,
        personal: true,
      });
      const shared = await recallAs(env, person.userId, {
        question,
        budget,
        personal: false,
      });
      expect({
        sameItems: inAnyOrder(pack.items),
        sameNotFound: pack.notFound,
        sameCut: pack.truncated,
        otherOrder:
          JSON.stringify(pack.items.map((item) => keyOf(item))) !==
          JSON.stringify(shared.items.map((item) => keyOf(item))),
        fromOwn,
      }).toStrictEqual({
        sameItems: inAnyOrder(shared.items),
        sameNotFound: shared.notFound,
        sameCut: shared.truncated,
        otherOrder: true,
        fromOwn: true,
      });
    }
  );

  it(
    "is not marked by an own match that changes nothing the model is handed, and the write runs at once",
    slow,
    async () => {
      const depot = word();
      const title = `unchanged-${unique()}`;
      const notes = await notesChat((app, release) => [
        writesNote(app, release, title),
        says("Written."),
      ]);
      const { person, chats, chat, ask, titles } = notes;
      // As many shared passages holding the question's telling word as a
      // way lists: no passage found by stop words alone is listed after.
      for (let copy = 0; copy < recallLimit; copy += 1) {
        // oxlint-disable-next-line no-await-in-loop -- added one after another
        await sharedSource(`${depot} ${word()} ${word()}`);
      }
      // Holds the question's stop words, none of its telling words.
      await ownSource(person.userId, `What about the ${word()} ${word()}?`);
      const question = `What about the ${depot}?`;
      // The person's own store does find it, by its stop words.
      const found = await personalBrainOf(
        inJurisdiction(env, env.BRAIN_STORE),
        person.userId
      ).find({
        question,
        reader: { person: person.userId, groups: [] },
        budget: turnRecallBudget,
      });
      await ask(question);

      expect({
        ownFound: found.stopWords.length,
        answers: await answers(chats.stub, chat.id),
        after: await titles(),
      }).toStrictEqual({
        ownFound: 1,
        answers: ["written"],
        after: [title],
      });
    }
  );
});
