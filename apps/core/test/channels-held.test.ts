import type { PendingAction } from "@grasp-os/shared/connect";
import {
  codeSubjectSchema,
  workContextSchema,
} from "@grasp-os/shared/permissions";
import { describe, expect, it } from "vite-plus/test";

import { connectionRead } from "../src/agent-scope.ts";
import { confirmAction } from "../src/channels/cards.tsx";
import { checkOf, viewOf } from "../src/channels/held.ts";
import { say } from "../src/channels/words.ts";
import { chatAgentId } from "../src/chats-rpc.ts";
import { codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { signedInApi, unique } from "./sign-in.ts";
import { member, messageFrom, post, reached, watched } from "./teams-door.ts";

// A Teams turn's held writes on one card (src/channels/held.ts, answer.ts,
// cards.tsx `heldWritesCard`): what the person sees before anything
// changes is exactly what would run, in order, with the ids and input
// hashes a press confirms; and the card warns when the turn read mail.

const idp = mockIdp();

watched();

const setUpTime = { timeout: 60_000 };

/** A held write as connect lists it, with `changes`. */
const held = (changes: Partial<PendingAction> = {}): PendingAction => ({
  id: crypto.randomUUID(),
  subject: codeSubjectSchema.parse({ type: "agent", agentId: chatAgentId }),
  appVersion: null,
  mode: "interactive",
  context: workContextSchema.parse({
    type: "chat",
    workspaceId: "workspace-1",
    chatId: "chat-1",
  }),
  restricted: false,
  permissionId: "p",
  connectionId: "connection-1",
  connectionName: "Microsoft 365 (anna@acme.test)",
  resource: null,
  action: "calendar.create",
  idempotencyKey: "c:1",
  input: JSON.stringify({ subject: "Focus", attendees: ["ben@acme.test"] }),
  inputHash: "a".repeat(64),
  requestedAt: new Date().toISOString(),
  binding: null,
  ...changes,
});

describe("a held write on the card", () => {
  it("shows its tool's own words and values, a list as one value", () => {
    const write = held({
      description: {
        title: "Put an event in your calendar",
        fields: [
          { input: "subject", label: "Title", value: "Focus" },
          {
            input: "attendees",
            label: "With",
            value: ["ben@acme.test", "cleo@acme.test"],
          },
        ],
        complete: true,
      },
    });
    expect(viewOf(write)).toStrictEqual({
      id: write.id,
      inputHash: write.inputHash,
      title: "Put an event in your calendar",
      values: [
        { label: "Title", value: "Focus" },
        { label: "With", value: "ben@acme.test, cleo@acme.test" },
      ],
      state: "held",
    });
  });

  it("shows every property of its exact input when its tool describes none, or only part of it", () => {
    const partial = held({
      description: {
        title: "Put an event in your calendar",
        fields: [{ input: "subject", label: "Title", value: "Focus" }],
        complete: false,
      },
    });
    const undescribed = held({ action: "mail.send" });
    expect([viewOf(partial).values, viewOf(undescribed)]).toStrictEqual([
      [
        { label: "subject", value: "Focus" },
        { label: "attendees", value: "ben@acme.test" },
      ],
      expect.objectContaining({
        title: "mail.send",
        values: [
          { label: "subject", value: "Focus" },
          { label: "attendees", value: "ben@acme.test" },
        ],
      }),
    ]);
  });
});

describe("the card's check line", () => {
  it("warns only when the turn read mail", () => {
    expect([
      checkOf([connectionRead("connection-1", "mail.search", null)]),
      checkOf([connectionRead("connection-1", "calendar.list", null)]),
      checkOf(["note:doc-1"]),
      checkOf([]),
    ]).toStrictEqual([{ read: "mail" }, undefined, undefined, undefined]);
  });
});

describe("a Teams turn that holds writes", setUpTime, () => {
  it("sends one card naming both, after its answer, carrying what a press confirms", async () => {
    const admin = await signedInApi(idp, "admin");
    // A send whose fields its server lists, so core can check a chat
    // app's write against them (channels/stephen-rules.ts).
    const mail = await mailConnection([], ["MAIL_SEND"]);
    const binding = `MAIL${unique()}`.toUpperCase();
    await requestGranted(idp, admin, {
      subject: { type: "agent", agentId: chatAgentId },
      object: { type: "connection", connectionId: mail.id },
      actions: ["MAIL_SEND"],
      binding,
    });
    const send = (to: string, subject: string) =>
      `await env.connections.call(${JSON.stringify(binding)}, "MAIL_SEND", ${JSON.stringify({ to, subject })});`;
    const person = await member(
      idp,
      codeStep(
        `export default async (self, env) => { ${send("ben@acme.test", "Invoice INV-7")} ${send("cleo@acme.test", "Reminder")} return "held"; };`
      ),
      says("Both mails wait for you to confirm them.")
    );

    await post(
      messageFrom(person.teams, {
        text: "Mail ben@acme.test the invoice and remind cleo@acme.test.",
      })
    );

    const waiting = await person.api.pendingActions.list();
    const { activities } = await reached(person.teams.conversation);
    const messages = activities
      .filter(({ type }) => type === "message")
      .map((activity) => JSON.stringify(activity));
    const [answer, card, ...more] = messages;
    expect({
      answer: answer?.includes("Both mails wait for you"),
      more,
      waiting: waiting.length,
      sent: await mail.did(),
    }).toStrictEqual({
      answer: true,
      more: [],
      waiting: 2,
      // Nothing went out: the card asks first.
      sent: { calls: 0, sent: [] },
    });
    // Both writes, in the order they were asked for, with their exact
    // values, and a Confirm that names exactly them.
    expect(card).toContain(confirmAction);
    const benAt = card?.indexOf("ben@acme.test") ?? -1;
    const cleoAt = card?.indexOf("cleo@acme.test") ?? -1;
    expect({
      ben: benAt >= 0,
      cleo: cleoAt >= 0,
      inOrder: benAt < cleoAt,
    }).toStrictEqual({
      ben: true,
      cleo: true,
      inOrder: true,
    });
    for (const write of waiting) {
      expect(card).toContain(write.id);
      expect(card).toContain(write.inputHash);
    }
    // Nothing read mail this turn: no check line.
    expect(card).not.toContain(say("checkMail", "en"));
  });
});
