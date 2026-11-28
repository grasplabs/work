import { sha256Hex } from "@grasp-os/shared/encoding";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { personalWorkspaceId } from "../src/personal-workspace.ts";
import { chatOf, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { signedInWithRole } from "./sign-in.ts";

// What a person's Workspace hands a chat's own object to take the chat
// over (workspace.ts `export*`, chat-export.ts): read only, for the chat
// its reference names and this Workspace holds, nothing else.

const idp = mockIdp();

const chatFor = async () => {
  const { userId } = await signedInWithRole(idp, "user");
  const made = await chatOf(userId, says("Noted."), says("Ok."));
  const ref = {
    workspaceId: made.id,
    chatId: chatIdSchema.parse(made.chat.id),
  };
  return { ...made, userId, ref };
};

describe("a chat's export from its Workspace", () => {
  it("hands over its messages a page at a time, what it is, its files, held writes and runs, the same each time", async () => {
    const chat = await chatFor();
    await chat.ask("First question.");
    await chat.ask("Second question.");
    await chat.stub.attachFile(
      chat.chat.id,
      chat.userId,
      { name: "notes.txt", type: "txt", bytes: 5, text: "hello" },
      { type: "person", userId: chat.userId }
    );
    await chat.stub.holdAppCall(
      chat.chat.id,
      chat.userId,
      {
        agentId: chat.agent.agentId,
        appId: crypto.randomUUID(),
        function: "notes.create",
        kind: "mutation",
        request: "held",
        requestHash: await sha256Hex("held"),
      },
      Date.now()
    );

    const all = await chat.stub.exportMessages(chat.ref, 0, 1000);
    const first = await chat.stub.exportMessages(chat.ref, 0, 2);
    const next = await chat.stub.exportMessages(
      chat.ref,
      first?.page.at(-1)?.id ?? 0,
      1000
    );
    const files = await chat.stub.exportFiles(chat.ref);
    const held = await chat.stub.exportHeldAppCalls(chat.ref);
    const ran = await chat.stub.exportTurnState(chat.ref);

    expect({
      facts: all?.facts,
      through: typeof all?.through,
      paged: [...(first?.page ?? []), ...(next?.page ?? [])].map(
        ({ id }) => id
      ),
      firstPage: first?.page.length,
      questions: (all?.page ?? []).filter(
        ({ message }) =>
          z.object({ role: z.string() }).parse(JSON.parse(message)).role ===
          "user"
      ).length,
      files: files?.map(({ name, text, parts }) => ({ name, text, parts })),
      held: held?.map(({ request, status }) => ({ request, status })),
      // Each turn's recall is a run of its own.
      runs: ran?.codeRuns.length,
      again: await chat.stub.exportMessages(chat.ref, 0, 1000),
    }).toStrictEqual({
      facts: {
        personId: chat.userId,
        via: "web",
        agentId: chat.agent.agentId,
        thread: null,
        restricted: false,
        privateRead: false,
      },
      through: "number",
      paged: all?.page.map(({ id }) => id),
      firstPage: 2,
      questions: 2,
      files: [{ name: "notes.txt", text: "hello", parts: 0 }],
      held: [{ request: "held", status: "waiting" }],
      runs: 2,
      again: all,
    });
  });

  it("hands over nothing for a reference naming another Workspace, a chat it doesn't hold, or one being deleted", async () => {
    const chat = await chatFor();
    const { userId: other } = await signedInWithRole(idp, "user");
    const elsewhere = {
      workspaceId: personalWorkspaceId(other),
      chatId: chat.ref.chatId,
    };
    const missing = {
      workspaceId: chat.ref.workspaceId,
      chatId: chatIdSchema.parse(crypto.randomUUID()),
    };
    const exportsOf = async (ref: typeof chat.ref) => [
      await chat.stub.exportMessages(ref, 0, 10),
      await chat.stub.exportFiles(ref),
      await chat.stub.exportFilePart(ref, crypto.randomUUID(), 0),
      await chat.stub.exportHeldAppCalls(ref),
      await chat.stub.exportTurnState(ref),
    ];
    const before = { elsewhere: await exportsOf(elsewhere) };
    const unheld = await exportsOf(missing);
    // A delete under way, as its first step marks it, its alarm far off.
    await runInDurableObject(chat.stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO chat_deletes (chat_id, person, actor, audited, next_at) VALUES (?, ?, ?, 0, ?)",
        chat.chat.id,
        JSON.stringify({ userId: chat.userId }),
        JSON.stringify({ type: "person", userId: chat.userId }),
        Date.now() + 3_600_000
      );
    });
    const deleting = await exportsOf(chat.ref);

    const none = [undefined, undefined, undefined, undefined, undefined];
    expect({ ...before, unheld, deleting }).toStrictEqual({
      elsewhere: none,
      unheld: none,
      deleting: none,
    });
  });
});
