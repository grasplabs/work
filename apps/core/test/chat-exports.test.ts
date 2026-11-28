import { sha256Hex } from "@grasp-os/shared/encoding";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { workspace } from "../src/durable-objects.ts";
import { personalWorkspaceId } from "../src/personal-workspace.ts";
import { chatFilePartBytes } from "../src/workspace.ts";
import { chatOf, says, setObjectEnv } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInWithRole } from "./sign-in.ts";

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

/** The chats' own objects, none of which can be reached. */
const away = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error("The chats' objects are away");
    },
  }
);

/** Restarts `stub`'s object, as an eviction or a deploy does. */
const restart = async (stub: ReturnType<typeof workspace>): Promise<void> => {
  await runInDurableObject(stub, (_instance, state) => {
    state.abort("Restarted by the test");
  }).catch(() => {
    // Aborting fails the call that aborted: that is the restart.
  });
};

/** The text of the first of `files`, as its one part hands it over. */
const textOf = async (
  chat: Awaited<ReturnType<typeof chatFor>>,
  files: readonly { id: string }[] | undefined
): Promise<string> =>
  new TextDecoder().decode(
    await chat.stub.exportFilePart(chat.ref, files?.[0]?.id ?? "", 0)
  );

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

    const all = await chat.stub.exportMessages(chat.ref, 0, 200);
    const first = await chat.stub.exportMessages(chat.ref, 0, 2);
    const next = await chat.stub.exportMessages(
      chat.ref,
      first?.next ?? 0,
      200
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
      files: files?.map((file) => ({
        name: file.name,
        bytes: file.bytes,
        parts: file.parts,
      })),
      text: await textOf(chat, files),
      held: held?.map(({ request, status }) => ({ request, status })),
      // Each turn's recall is a run of its own.
      runs: ran?.codeRuns.length,
      again: await chat.stub.exportMessages(chat.ref, 0, 200),
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
      files: [{ name: "notes.txt", bytes: 5, parts: 1 }],
      text: "hello",
      held: [{ request: "held", status: "waiting" }],
      runs: 2,
      again: all,
    });
  });

  it("hands over a picture past one part whole, in its parts", async () => {
    const chat = await chatFor();
    // A picture past one part, kept in two.
    const picture = new Uint8Array(chatFilePartBytes + 1000).map(
      (_, at) => at % 251
    );
    await chat.stub.attachFile(
      chat.chat.id,
      chat.userId,
      { name: "plan.png", type: "png", bytes: picture.byteLength, picture },
      { type: "person", userId: chat.userId }
    );
    const [shown] = (await chat.stub.exportFiles(chat.ref)) ?? [];
    const parts = await Promise.all(
      Array.from(
        { length: shown?.parts ?? 0 },
        async (_, part) =>
          await chat.stub.exportFilePart(chat.ref, shown?.id ?? "", part)
      )
    );
    const joined = parts.flatMap((part) =>
      part === undefined ? [] : [...part]
    );

    expect({
      bytes: shown?.bytes,
      parts: parts.length,
      whole:
        joined.length === picture.byteLength &&
        joined.every((byte, at) => byte === picture[at]),
    }).toStrictEqual({ bytes: picture.byteLength, parts: 2, whole: true });
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

  it("hands over nothing of a chat once its person's erasure began, before it wiped anything", async () => {
    const chat = await chatFor();
    await chat.ask("A question.");
    const during = await runInDurableObject(chat.stub, async (instance) => {
      // Asked as the erasure begins: it has marked itself, and wiped nothing.
      const erased = instance.erasePerson(chat.userId);
      const messages = instance.exportMessages(chat.ref, 0, 10);
      const files = instance.exportFiles(chat.ref);
      const part = instance.exportFilePart(chat.ref, crypto.randomUUID(), 0);
      const held = instance.exportHeldAppCalls(chat.ref);
      const ran = instance.exportTurnState(chat.ref);
      await erased;
      return [await messages, files, part, await held, await ran];
    });

    expect(during).toStrictEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("hands over, tells and hands the Brain nothing of a chat once its person's erasure began, also after a restart before the wipe, and the erasure asked again finishes", async () => {
    const chat = await chatFor();
    await chat.ask("A question.");
    const answerId = await runInDurableObject(
      chat.stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ id: number }>(
            "SELECT id FROM chat_messages WHERE json_extract(message, '$.role') = 'assistant' ORDER BY id DESC LIMIT 1"
          )
          .one().id
    );
    const reads = async (stub: typeof chat.stub) => {
      const { kind: forBrain } = await stub.turnForBrain(
        chat.chat.id,
        chat.userId,
        answerId
      );
      return {
        exports: [
          await stub.exportMessages(chat.ref, 0, 10),
          await stub.exportFiles(chat.ref),
          await stub.exportFilePart(chat.ref, crypto.randomUUID(), 0),
          await stub.exportHeldAppCalls(chat.ref),
          await stub.exportTurnState(chat.ref),
        ].map((each) => each !== undefined),
        told: await outcome(
          stub.heldDecided(
            chat.chat.id,
            chat.userId,
            { id: crypto.randomUUID(), action: "mail.send" },
            "declined"
          )
        ),
        forBrain,
      };
    };
    const before = await reads(chat.stub);
    // The erasure marks itself, then fails before it wiped anything: the
    // chats' own objects can't be reached.
    const restore = await setObjectEnv(chat.stub, { CHAT_SESSIONS: away });
    let failed: string;
    try {
      failed = await outcome(chat.stub.erasePerson(chat.userId));
    } finally {
      await restore();
    }
    await restart(chat.stub);
    // A stub of its own: one an object was restarted through is broken.
    const woken = workspace(env, chat.ref.workspaceId);
    const after = await reads(woken);
    const erased = await woken.erasePerson(chat.userId);
    const left = await runInDurableObject(woken, (_instance, state) => ({
      chats: state.storage.sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM chats")
        .one().count,
      kept: [...state.storage.kv.list()].length,
    }));

    expect({ before, failed, after, erased, left }).toStrictEqual({
      before: {
        exports: [true, true, false, true, true],
        told: "ok",
        forBrain: "question",
      },
      failed: "Error: The chats' objects are away",
      after: {
        exports: [false, false, false, false, false],
        told: "agent.chat_not_found",
        forBrain: "deleting",
      },
      erased: { chats: 1 },
      left: { chats: 0, kept: 0 },
    });
  });

  it("refuses a page or part asked for past its bounds: a cursor, size or part that isn't a whole number in range", async () => {
    const chat = await chatFor();
    await chat.ask("A question.");
    const page = async (after: unknown, limit: unknown) =>
      await outcome(chat.stub.exportMessages(chat.ref, after, limit));
    const part = async (at: unknown) =>
      await outcome(
        chat.stub.exportFilePart(chat.ref, crypto.randomUUID(), at)
      );

    expect({
      limits: await Promise.all(
        [Number.NaN, 0, -1, 1.5, 201, Number.POSITIVE_INFINITY, "2"].map(
          async (limit) => await page(0, limit)
        )
      ),
      afters: await Promise.all(
        [-1, 1.5, Number.NaN, "0"].map(async (after) => await page(after, 10))
      ),
      parts: await Promise.all(
        [-1, 0.5, Number.NaN].map(async (at) => await part(at))
      ),
      bounds: [await page(0, 1), await page(0, 200)],
    }).toStrictEqual({
      limits: Array.from({ length: 7 }, () => "agent.invalid_request"),
      afters: Array.from({ length: 4 }, () => "agent.invalid_request"),
      parts: Array.from({ length: 3 }, () => "agent.invalid_request"),
      bounds: ["ok", "ok"],
    });
  });

  it("hands over a page of messages up to its bytes, and says where the next goes on", async () => {
    const chat = await chatFor();
    // Three messages near a row's most and a short one, kept as a long
    // chat keeps them: past a page's bytes together.
    const sizes = [1_900_000, 1_900_000, 1_900_000, 10];
    await runInDurableObject(chat.stub, (_instance, state) => {
      for (const size of sizes) {
        state.storage.sql.exec(
          "INSERT INTO chat_messages (chat_id, message, created_at) VALUES (?, ?, ?)",
          chat.chat.id,
          JSON.stringify({
            role: "user",
            content: "x".repeat(size),
            timestamp: Date.now(),
          }),
          Date.now()
        );
      }
    });
    const pages: number[][] = [];
    let after: number | null = 0;
    while (after !== null) {
      // oxlint-disable-next-line no-await-in-loop -- a page after the other
      const handed = await chat.stub.exportMessages(chat.ref, after, 200);
      pages.push((handed?.page ?? []).map(({ message }) => message.length));
      after = handed?.next ?? null;
    }

    expect(pages.map((page) => page.length)).toStrictEqual([2, 2]);
  });
});
