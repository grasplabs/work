import { companyToolClasses, connectErrors } from "@grasp-os/shared/connect";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  chatOf,
  codeResults,
  codeStep,
  returnedOf,
  says,
} from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { signedInApi } from "./sign-in.ts";

// A Composio app, once connected and its tools allowed, works in the
// chats of those its connection is open to (its audience, "Open to"), as
// each tool is allowed: Read runs at once, Write waits for its person's
// press, Never isn't there. Nothing else is asked: neither the company's
// class switches nor a pointer at the app. These start from the ways it
// could fail: a read refused while every switch is off; a person outside
// the audience reaching it; a tool set to Never offered or run; a tool
// Composio doesn't call read-only running unasked; a write running
// without its press.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

type Admin = Awaited<ReturnType<typeof signedInApi>>;

const message = (code: Parameters<typeof connectErrors.create>[0]) =>
  connectErrors.create(code).message;

/**
 * Turns every one of the company's class switches off, and takes away any
 * pointer at the app `connectionId`: after the connection is made, as
 * making one in these tests turns some on and points at it
 * (mail-connection.ts `agentMayUse`).
 */
const nothingElseOn = async (
  admin: Admin,
  connectionId: string
): Promise<void> => {
  for (const toolClass of companyToolClasses) {
    // oxlint-disable-next-line no-await-in-loop -- one setting at a time
    await admin.api.connections.setToolClass(toolClass, { who: "nobody" });
  }
  await env.DB.prepare("DELETE FROM app_pointers WHERE connection_id = ?")
    .bind(connectionId)
    .run();
  const pointers = await admin.api.connections.appPointers();
  expect(
    pointers.some((each) => each.connectionId === connectionId)
  ).toBeFalsy();
};

/**
 * What a chat of `personId`'s finds of `connectionId` and how its calls
 * end: the tools `list()` counts for it, by class, and each call's end,
 * the connection named by its ID, as a chat names one it uses with no
 * grant.
 */
const triedIn = async (
  personId: string,
  connectionId: string,
  calls: Record<string, Call>
) => {
  const chat = await chatOf(
    personId,
    codeStep(
      `export default async (self, env) => {
        const id = ${JSON.stringify(connectionId)};
        const listed = (await env.connections.list()).find((each) => each.name === id);
        const tried = async (action, input) => { try { const { pending } = await env.connections.call(id, action, input); return pending === null ? "done" : "held"; } catch (error) { return error.message; } };
        const ends = {};
        for (const [name, [action, input]] of Object.entries(${JSON.stringify(calls)})) {
          ends[name] = await tried(action, input);
        }
        return { listed: listed === undefined ? null : listed.tools, ends };
      };`
    ),
    says("Done.")
  );
  await chat.ask("Look in the app.");
  const [result] = await codeResults(chat.stub, chat.chat.id);
  return returnedOf(result?.text);
};

/** A call a chat's code makes: its action and input. */
type Call = [string, Record<string, unknown>];

const search: Call = ["mail.search", { query: "invoice" }];
const send: Call = ["mail.send", { to: "ben@acme.test", subject: "Status" }];

describe("a Composio app connected and allowed", setUpTime, () => {
  it("reads at once and asks before a change for someone it is open to, with every class switch off and no pointer", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const mail = await mailConnection(
      [],
      ["mail.send", { name: "mail.search", read: true }],
      { audience: "everyone" }
    );
    await nothingElseOn(admin, mail.id);

    await expect(
      triedIn(person.userId, mail.id, { search, send })
    ).resolves.toStrictEqual({
      listed: { "read-company": 1, "change-company": 1 },
      ends: { search: "done", send: "held" },
    });
    // The change waits for the person's press: nothing sent yet.
    await expect(mail.did()).resolves.toMatchObject({ sent: [] });
  });

  it("is neither listed nor reached by someone it isn't open to", async () => {
    await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const mail = await mailConnection(
      [],
      ["mail.send", { name: "mail.search", read: true }]
    );

    await expect(
      triedIn(person.userId, mail.id, { search, send })
    ).resolves.toStrictEqual({
      listed: null,
      ends: {
        search: message("connect.connection_not_found"),
        send: message("connect.connection_not_found"),
      },
    });
    await expect(mail.searched()).resolves.toStrictEqual([]);
  });

  it("neither lists nor runs a tool set to Never", async () => {
    await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    // Sending is left out of what the admin allowed: Never.
    const mail = await mailConnection(
      [],
      [{ name: "mail.search", read: true }],
      { audience: "everyone" }
    );

    // Refused, saying where the admin allows it.
    await expect(
      triedIn(person.userId, mail.id, { search, send })
    ).resolves.toStrictEqual({
      listed: { "read-company": 1 },
      ends: { search: "done", send: message("connect.class_unknown") },
    });
    await expect(mail.did()).resolves.toMatchObject({ sent: [] });
  });

  it("asks before a tool Composio doesn't call read-only, even one stored as a read", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const mail = await mailConnection([], [{ name: "mail.send", read: true }], {
      audience: "everyone",
    });
    await nothingElseOn(admin, mail.id);

    await expect(
      triedIn(person.userId, mail.id, { send })
    ).resolves.toStrictEqual({
      listed: { "change-company": 1 },
      ends: { send: "held" },
    });
    await expect(mail.did()).resolves.toMatchObject({ sent: [] });
  });
});
