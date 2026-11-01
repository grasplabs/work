import type { Message } from "@earendil-works/pi-ai";
import { hasEvery } from "@grasp-os/shared/chat-search";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { saidOf, snippetOf } from "../src/chat-search.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { searchHitsMax } from "../src/workspace.ts";
import { model, says, transcript } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import type { Answer } from "./model-provider.ts";
import { signedInApi } from "./sign-in.ts";

// Finding a chat by what was said in it, through `/rpc` as the ⌘K window
// asks: every word searched for must be in the chat's title, its project's
// name or what was said, and one found by what was said shows where. The
// ways it can fail: someone finds another person's chat (an admin too);
// code, its results or the model's thoughts match as if they were said; a
// deleted chat is still found; a chat kept before searches were is never
// found by what was said in it.

const idp = mockIdp();

const person = async (role: "user" | "admin" = "user") => {
  const signedIn = await signedInApi(idp, role);
  return { ...signedIn, chats: signedIn.api.chats };
};
type Person = Awaited<ReturnType<typeof person>>;

const objectOf = ({ userId }: { userId: string }) =>
  workspace(env, personalWorkspaceId(userId));

/** Asks `text` in the chat, and waits for `answer`. */
const ask = async (
  someone: Person,
  chatId: string,
  text: string,
  answer: Answer
) => {
  await fakeProvider(answer);
  await someone.chats.send(chatId, { text, model });
  await vi.waitFor(
    async () => {
      const messages = await transcript(objectOf(someone), chatId);
      expect(messages.at(-1)?.role).toBe("assistant");
      const [listed] = await someone.chats.list();
      expect(listed?.running).toBeFalsy();
    },
    { timeout: 10_000 }
  );
};

/** The titles a search finds, and where each was said, as the row shows it. */
const found = async (someone: Person, query: string) => {
  const hits = await someone.chats.search(query);
  return hits.map(({ chat, said }) => ({
    title: chat.title,
    said: said === null ? null : `${said.before}[${said.found}]${said.after}`,
  }));
};

describe("what a search looks through", () => {
  it("needs every word, wherever each is", () => {
    expect({
      split: hasEvery("lease MARCH", "The lease", "ends in March"),
      missing: hasEvery("lease june", "The lease ends in March"),
      nothing: hasEvery("   ", "anything"),
      otherScript: hasEvery("über straße", "Ein Brief ÜBER die Straße"),
    }).toStrictEqual({
      split: true,
      missing: false,
      nothing: true,
      otherScript: true,
    });
  });

  it("shows the stretch around the search as typed, else its first word that is there", () => {
    const said =
      "We spoke about the office move at length last week, and then the Hoogvliet lease ends on 31 March 2027, which the landlord confirmed in writing to us. The rent rises each year.";
    expect({
      phrase: snippetOf(said, "lease ENDS"),
      word: snippetOf(said, "june landlord"),
      none: snippetOf(said, "june"),
      short: snippetOf("Lease ends", "ends"),
      // A letter whose lower case is longer leaves the rest where it was.
      dotted: snippetOf("İİİİ İstanbul Lojistik ends in March", "lojistik"),
      stretch: snippetOf("the lease ends", "lease", {
        before: true,
        after: true,
      }),
    }).toStrictEqual({
      phrase: {
        before: "…and then the Hoogvliet ",
        found: "lease ends",
        after:
          " on 31 March 2027, which the landlord confirmed in writing to us. The…",
      },
      word: {
        before: "…31 March 2027, which the ",
        found: "landlord",
        after: " confirmed in writing to us. The rent rises each year.",
      },
      none: null,
      short: { before: "Lease ", found: "ends", after: "" },
      dotted: {
        before: "İİİİ İstanbul ",
        found: "Lojistik",
        after: " ends in March",
      },
      stretch: { before: "…the ", found: "lease", after: " ends…" },
    });
  });

  it("is what the person and Grasp said, as plain words, never code, results or thoughts", () => {
    const question: Message = {
      role: "user",
      content: "When does the\n\nlease end?",
      timestamp: 0,
    };
    const answer: Message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret musing" },
        { type: "text", text: "It ends on **31 March**, see `the lease`." },
        {
          type: "toolCall",
          id: "call_1",
          name: "executeCode",
          arguments: { code: "await leases.find()" },
        },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 0,
    };
    const result: Message = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "executeCode",
      content: [{ type: "text", text: "lease row 42" }],
      isError: false,
      timestamp: 0,
    };
    expect([question, answer, result].map(saidOf)).toStrictEqual([
      "When does the lease end?",
      "It ends on 31 March , see the lease .",
      "",
    ]);
  });
});

describe("chats.search", () => {
  it("finds a person's chat by its title, its project or what was said, the latest first", async () => {
    const ann = await person();
    const project = await ann.chats.createProject("Moving office");
    const lease = await ann.chats.create("Invoices");
    const travel = await ann.chats.create("Travel", project.id);
    await ask(
      ann,
      lease.id,
      "When does the Hoogvliet lease end?",
      says("The lease with **Hoogvliet** ends on 31 March 2027.")
    );
    await ask(ann, travel.id, "Book the train to Lyon", says("Booked."));

    expect({
      bySaid: await found(ann, "LEASE march"),
      byProjectAndSaid: await found(ann, "moving lyon"),
      byTitle: await found(ann, "invoices"),
      notEveryWord: await found(ann, "lease lyon"),
      latestFirst: await found(ann, "the"),
      nothing: await found(ann, "  "),
    }).toStrictEqual({
      bySaid: [
        {
          title: "Invoices",
          said: "When does the Hoogvliet [lease] end?",
        },
      ],
      byProjectAndSaid: [{ title: "Travel", said: "Book the train to [Lyon]" }],
      byTitle: [{ title: "Invoices", said: null }],
      notEveryWord: [],
      latestFirst: [
        { title: "Travel", said: "Book [the] train to Lyon" },
        {
          title: "Invoices",
          said: "When does [the] Hoogvliet lease end?",
        },
      ],
      nothing: [],
    });
  });

  it("finds only the person's own chats, not even an admin finds anyone else's, and forgets a deleted one", async () => {
    const ann = await person();
    const ben = await person();
    const admin = await person("admin");
    const chat = await ann.chats.create("Lease");
    await ask(ann, chat.id, "Hoogvliet terms?", says("Hoogvliet renews."));

    expect({
      ann: await found(ann, "hoogvliet"),
      ben: await found(ben, "hoogvliet"),
      admin: await found(admin, "hoogvliet"),
    }).toStrictEqual({
      ann: [{ title: "Lease", said: "[Hoogvliet] terms?" }],
      ben: [],
      admin: [],
    });

    await ann.chats.remove(chat.id);
    await expect(found(ann, "hoogvliet")).resolves.toStrictEqual([]);
  });

  it("finds a chat kept before searches were by what was said in it, and keeps up with it after", async () => {
    const ann = await person();
    const chat = await ann.chats.create("Older");
    await ask(ann, chat.id, "Who signs for Hoogvliet?", says("Mira does."));
    // As a chat kept before searches were: nothing kept of what it said.
    await runInDurableObject(objectOf(ann), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM chat_search_text");
    });

    await expect(found(ann, "mira")).resolves.toStrictEqual([
      { title: "Older", said: "[Mira] does." },
    ]);
    await ask(ann, chat.id, "And for Lyon?", says("Jonas."));
    await expect(found(ann, "hoogvliet jonas")).resolves.toStrictEqual([
      {
        title: "Older",
        said: "Who signs for [Hoogvliet]?",
      },
    ]);
  });

  it("looks in one project before it keeps a page's worth", async () => {
    const ann = await person();
    const project = await ann.chats.createProject("Lyon office");
    await ann.chats.create("Lease in Lyon", project.id);
    // Each more recent than the project's, and one more than a page holds.
    await Promise.all(
      Array.from(
        { length: searchHitsMax },
        async (_, index) => await ann.chats.create(`Lease ${index}`)
      )
    );

    const everywhere = await ann.chats.search("lease");
    const inProject = await ann.chats.search("lease", project.id);
    expect({
      everywhere: everywhere.length,
      lyonAmongThem: everywhere.some(({ chat }) => chat.projectId !== null),
      inProject: inProject.map(({ chat }) => chat.title),
    }).toStrictEqual({
      everywhere: searchHitsMax,
      lyonAmongThem: false,
      inProject: ["Lease in Lyon"],
    });
  });

  it("keeps finding what was said in a chat longer than one row holds", async () => {
    const ann = await person();
    const chat = await ann.chats.create("Long");
    // Three answers of 600,000 characters: together, said and folded, far
    // past the 2 MB a Durable Object's SQLite keeps in one row.
    const long = `${"lease ".repeat(3000)}Hoogvliet signs ${"lease ".repeat(97_000)}`;
    for (const part of ["one", "two", "three"]) {
      // oxlint-disable-next-line no-await-in-loop -- one turn after another, as a person asks
      await ask(ann, chat.id, `Part ${part}`, says(long));
    }
    await ask(ann, chat.id, "Who pays?", says("Mira pays."));

    expect({
      last: await found(ann, "mira"),
      inTheMiddle: await found(ann, "hoogvliet"),
    }).toStrictEqual({
      last: [{ title: "Long", said: "[Mira] pays." }],
      inTheMiddle: [
        {
          title: "Long",
          said: `…${"lease ".repeat(4)}[Hoogvliet] signs ${"lease ".repeat(10)}lea…`,
        },
      ],
    });
  });
});
