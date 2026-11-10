import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { mockIdp } from "./idp.ts";
import {
  fakeProvider,
  call,
  valueOf,
  codeOf,
  idSchema,
  savedSchema,
  draftOf,
  sourcesOf,
  statementsOf,
  copyOf,
  connected,
  extracted,
  foundSchema,
  guest,
  chatNotesSchema,
} from "./intake-harness.ts";
import { signedInApi, unique } from "./sign-in.ts";

// The intake, the built-in App (apps/core/blueprints/intake/): drafts of
// a source and its statements, typed in or taken out of notes or a
// stakeholder's chat by a model, reviewed, and saved as a source and its
// statements, all in the App's own store, which only its builders reach.
// What can go wrong, tried below: a draft saved without anyone reviewing
// it, saved twice, or saved halfway; someone who isn't one of the App's
// builders reading or writing drafts, or inviting, listing or reading
// stakeholder chats through its actions; edits written over someone
// else's; a draft that doesn't fit kept or saved; and a source taken from
// a stakeholder's chat saved without the mark of their untrusted words,
// or one typed in saved with it.
//
// Here: stakeholder chats; the rest in intake.test.ts and
// intake-notes.test.ts.

const idp = mockIdp();

describe("stakeholder chats", { timeout: 90_000 }, () => {
  beforeEach(connected);

  it("invites a stakeholder whose chat, once they finished it, a model takes statements out of, as a guest's draft reviewed before it is saved", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await copyOf(admin, { guests: true });
    const name = `Ben ${unique()}`;
    const invited = z
      .object({ chat: z.object({ id: z.string() }), link: z.string() })
      .parse(
        valueOf(await call(admin, app, "chats.invite", "action", { name }))
      );
    const token = new URL(invited.link).hash.slice(1);
    const found = {
      statements: [
        {
          text: "Invoices wait a week for approval.",
          tags: ["blocker", "time_sink"],
          quote: "They wait a week for the second signature.",
        },
      ],
    };
    await fakeProvider(
      { text: "What slows your work down?", inputTokens: 40, outputTokens: 8 },
      { text: "Thank you. Press Finish.", inputTokens: 60, outputTokens: 6 }
    );
    await guest({ action: "open", token });
    await guest({ action: "send", token, text: "I approve invoices." });
    await guest({
      action: "send",
      token,
      text: "They wait a week for the second signature.",
    });
    await guest({ action: "finish", token });
    const listed = valueOf(await call(admin, app, "chats.overview", "action"));
    // The page reads the chat as notes through the App's own action,
    // then has the workflow read them.
    const read = chatNotesSchema.parse(
      valueOf(
        await call(admin, app, "chats.notes", "action", {
          chat: invited.chat.id,
        })
      )
    );
    const { run, provider } = await extracted(
      admin,
      admin,
      app,
      { notes: read.notes, lines: read.lines },
      await fakeProvider({
        text: JSON.stringify(found),
        inputTokens: 200,
        outputTokens: 60,
      })
    );
    const draftId = idSchema.parse(
      valueOf(
        await call(admin, app, "drafts.propose", "mutation", {
          source: { ...read.source, notes: read.notes },
          statements: foundSchema.parse(run.result).statements,
          guest: true,
        })
      )
    );
    const opened = await draftOf(admin, app, draftId);
    const saved = savedSchema.parse(
      valueOf(
        await call(admin, app, "drafts.save", "mutation", {
          id: draftId,
          source: opened?.source,
          statements: opened?.statements,
        })
      )
    );
    const [source] = await sourcesOf(admin, app);
    const extraction = JSON.stringify(provider.requests[0]?.body);

    expect({
      listed: z
        .object({
          chats: z.array(
            z.object({ id: z.string(), status: z.string(), turns: z.number() })
          ),
        })
        .parse(listed)
        .chats.filter(({ id }) => id === invited.chat.id)
        .map(({ id, status, turns }) => ({ id, status, turns })),
      origin: opened?.origin,
      source: opened && {
        title: opened.source.title,
        medium: opened.source.medium,
        from: opened.source.from,
      },
      // The chat, read as notes: the questions and the guest's answers.
      notes: opened?.source.notes,
      // The chat's lines, as data, each said by whom, and not its text.
      lines: extraction.includes(
        '{\\"role\\":\\"guest\\",\\"text\\":\\"They wait a week for the second signature.\\"}'
      ),
      statements: opened?.statements,
      // Saved marked as a guest's words.
      guest: [
        source?.guest,
        ...(await statementsOf(admin, app, saved.source).then((statements) =>
          statements.map(({ guest: marked }) => marked)
        )),
      ],
    }).toStrictEqual({
      listed: [{ id: invited.chat.id, status: "finished", turns: 2 }],
      origin: "guest",
      source: { title: `Chat with ${name}`, medium: "chat", from: name },
      notes: [
        `${name}: I approve invoices.`,
        "Question: What slows your work down?",
        `${name}: They wait a week for the second signature.`,
        "Question: Thank you. Press Finish.",
      ].join("\n\n"),
      lines: true,
      statements: found.statements,
      guest: [true, true],
    });
  });

  it("reads no chat a stakeholder hasn't answered, and lists none while no admin let the App invite", async () => {
    const admin = await signedInApi(idp, "admin");
    const unbound = await copyOf(admin);
    const app = await copyOf(admin, { guests: true });
    const invited = z
      .object({ chat: z.object({ id: z.string() }) })
      .parse(
        valueOf(
          await call(admin, app, "chats.invite", "action", { name: "Cleo" })
        )
      );
    expect({
      unanswered: codeOf(
        await call(admin, app, "chats.notes", "action", {
          chat: invited.chat.id,
        })
      ),
      unbound: valueOf(await call(admin, unbound, "chats.overview", "action")),
      invite: codeOf(
        await call(admin, unbound, "chats.invite", "action", { name: "Cleo" })
      ),
    }).toStrictEqual({
      unanswered: "intake.empty_chat",
      unbound: { writable: true, chats: null },
      invite: "resource.unavailable",
    });
  });
});
