import {
  aiProviders,
  graspAi,
  organizationProviderIds,
} from "@grasp-os/shared/ai-providers";
import { seedTitleOf } from "@grasp-os/shared/chat";
import type { ChatSummary } from "@grasp-os/shared/chat";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { modelUsage } from "../src/db/core/schema.ts";
import { isRouteApi, parseModelRef } from "../src/model-catalog.ts";
import { spendMonth } from "../src/model-spend.ts";
import { model, pausedReply, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider, fakeProviderFor } from "./model-provider.ts";
import type { FakeProvider, ProviderReply } from "./model-provider.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { startedChat } from "./started-chats.ts";

// A new chat's title: named after the start of its first question (its
// seed), then, as its first turn begins, from that question by the
// organization's provider's small model, in the background. The ways it
// can fail come first: the answer waits on the title; a title overwrites
// what the person named the chat, because it came later; a failed, slow
// or odd answer becomes the title, or fails the turn; the title goes to a
// dearer or an older model than the provider's newest small one, or to
// another maker's; the call reads more than the question; it goes out
// past the organization's limit, or isn't counted.

const idp = mockIdp();

/** A member signed in on a connection of their own. */
const person = async () => await signedInApi(idp, "user");
type Person = Awaited<ReturnType<typeof person>>;

/** Waits until `check` holds. */
const until = async (check: () => unknown, timeout = 10_000) => {
  await vi.waitFor(check, { timeout });
};

/**
 * Follows `someone`'s list as the sidebar does, pushed as it changes
 * (`chats.watchList`): each chat as the updates so far make it.
 */
const followList = async ({ api }: Person) => {
  const rows = new Map<string, ChatSummary>();
  /** The title each chat was first listed with. */
  const first = new Map<string, string>();
  await api.chats.watchList((update) => {
    if (update.full) {
      rows.clear();
    }
    for (const row of update.chats) {
      rows.set(row.id, row);
      if (!first.has(row.id)) {
        first.set(row.id, row.title);
      }
    }
  });
  return {
    title: (chat: Pick<ChatSummary, "id">) => rows.get(chat.id)?.title,
    firstTitle: (chat: Pick<ChatSummary, "id">) => first.get(chat.id),
    /** Whether its answer came: the turn ended, with news to read. */
    answered: (chat: Pick<ChatSummary, "id">) =>
      rows.get(chat.id)?.running === false &&
      rows.get(chat.id)?.unread === true,
  };
};

/** A new chat of `someone`'s, asked `question`, as the page asks one. */
const askNew = async ({ api }: Person, question: string, asked = model) => {
  const chat = { id: crypto.randomUUID() };
  const key = crypto.randomUUID();
  await api.chats.send(chat.id, {
    text: question,
    model: asked,
    key,
    start: { key, title: seedTitleOf(question) },
  });
  return chat;
};

/** The title `someone`'s list gives `chat` when asked for it whole. */
const listedTitle = async ({ api }: Person, chat: Pick<ChatSummary, "id">) => {
  const listed = await api.chats.list();
  return listed.find(({ id }) => id === chat.id)?.title;
};

/** What a request's body says, as one string. */
const said = (body: unknown): string => JSON.stringify(body) ?? "";

/** The model a provider request named, as the provider's API names it. */
const modelOf = (body: unknown): unknown =>
  typeof body === "object" && body !== null && "model" in body
    ? body.model
    : undefined;

/** `someone`'s usage rows for chat titles, by model. */
const titleUsage = async ({ userId }: Person) =>
  await drizzle(env.DB)
    .select({ model: modelUsage.model })
    .from(modelUsage)
    .where(
      and(eq(modelUsage.personId, userId), eq(modelUsage.purpose, "chat.title"))
    );

/** Queues `replies` as `provider`'s answers to the titles it is asked for. */
const titlesAnswer = (provider: FakeProvider, ...replies: ProviderReply[]) => {
  provider.titleReplies.push(...replies);
};

describe("a new chat's title", () => {
  it("is the seed at once, then a short title from the first question alone, by the provider's newest small model, counted as chat titles, and pushed to the list", async () => {
    const ann = await person();
    const provider = await fakeProvider(says("Here it is."));
    titlesAnswer(provider, says('"Quarterly travel budget." ✈️'));
    const list = await followList(ann);
    const question =
      "Can you help me work out the travel budget for the next quarter?\nWe have six people travelling.";

    const chat = await askNew(ann, question);

    await until(() => {
      expect(list.firstTitle(chat)).toBe(seedTitleOf(question));
    });
    await until(() => {
      expect(list.title(chat)).toBe("Quarterly travel budget");
    });
    const [asked] = provider.titles;
    expect({
      // The default is Claude Sonnet 4.5: the title goes to Anthropic's
      // newest generation's cheapest, of the same key.
      model: modelOf(asked?.body),
      key: asked?.headers.get("x-api-key"),
      question: said(asked?.body).includes(
        JSON.stringify(question).slice(1, -1)
      ),
      // The question alone: no other message, no tools, nothing recalled.
      tools: said(asked?.body).includes('"tools"'),
      theirs: said(asked?.body).match(/"role":"user"/gu)?.length,
    }).toStrictEqual({
      model: "claude-haiku-5-5",
      key: provider.key,
      question: true,
      tools: false,
      theirs: 1,
    });
    await until(async () => {
      await expect(titleUsage(ann)).resolves.toStrictEqual([
        { model: "anthropic/claude-haiku-5-5" },
      ]);
    });
  });

  it("never holds up the answer: the turn's model answers while the title still waits, and a title that never comes leaves the seed", async () => {
    const ann = await person();
    const provider = await fakeProvider(says("Here it is."));
    titlesAnswer(provider, { hang: true });
    const list = await followList(ann);
    const question = "What changed in the supplier contract?";

    const chat = await askNew(ann, question);

    await until(() => {
      expect(list.answered(chat)).toBeTruthy();
    });
    expect({
      asked: provider.titles.length,
      waiting: provider.titles[0]?.signal.aborted,
      title: list.title(chat),
    }).toStrictEqual({
      asked: 1,
      waiting: false,
      title: seedTitleOf(question),
    });
    // The gateway gives up on it in the end: the chat keeps its seed.
    await until(() => {
      expect(provider.titles[0]?.signal.aborted).toBeTruthy();
    }, 40_000);
    expect(list.title(chat)).toBe(seedTitleOf(question));
  });

  it("never replaces a rename that lands first", async () => {
    const ann = await person();
    const provider = await fakeProvider(says("Here it is."));
    const { reply, release } = pausedReply(
      says("Supplier contract changes"),
      1
    );
    titlesAnswer(provider, reply);
    const list = await followList(ann);

    const chat = await askNew(ann, "What changed in the supplier contract?");
    await until(() => {
      expect(provider.titles).toHaveLength(1);
    });
    await ann.api.chats.rename(chat.id, "Contract");
    release();

    // The title call answered and was counted: it landed on nothing.
    await until(async () => {
      await expect(titleUsage(ann)).resolves.toHaveLength(1);
    });
    expect(list.title(chat)).toBe("Contract");
    await expect(listedTitle(ann, chat)).resolves.toBe("Contract");
  });

  it("keeps the seed, and the turn answers, when the call fails or answers no title: several lines, a refusal, too long, nothing; never asked again of a dearer model", async () => {
    const ann = await person();
    const answers: ProviderReply[] = [
      { status: 500 },
      // Refused for its key: no other model is asked for the title.
      { status: 401, errorType: "authentication_error" },
      says("Sure! Here is a title:\nSupplier contract"),
      says("I'm sorry, I can't help with that"),
      says(
        "A title that goes on and on well past the few words a title should ever take"
      ),
      says(""),
    ];
    const provider = await fakeProvider(
      ...answers.map(() => says("Here it is."))
    );
    titlesAnswer(provider, ...answers);
    const list = await followList(ann);

    const chats = [];
    for (const [at] of answers.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- each title its own reply, in order
      const chat = await askNew(ann, `What changed in contract ${at + 1}?`);
      // oxlint-disable-next-line no-await-in-loop -- see above
      await until(() => {
        expect(list.answered(chat)).toBeTruthy();
        expect(provider.titles).toHaveLength(at + 1);
      });
      chats.push(chat);
    }

    // Each that answered is counted, though the chat keeps none of them.
    await until(async () => {
      await expect(titleUsage(ann)).resolves.toHaveLength(answers.length - 2);
    });
    expect(provider.titles).toHaveLength(answers.length);
    const listed = await ann.api.chats.list();
    expect(
      chats.map(({ id }) => listed.find((each) => each.id === id)?.title)
    ).toStrictEqual(
      answers.map((_, at) => seedTitleOf(`What changed in contract ${at + 1}?`))
    );
  });

  it("is never asked again of a fallback model when the default is already the small one", async () => {
    const ann = await person();
    const provider = await fakeProviderFor(
      ["openai/gpt-6-luna", "openai/gpt-6.2-sol"],
      says("Here it is.")
    );
    titlesAnswer(provider, { status: 401, errorType: "authentication_error" });
    const list = await followList(ann);
    const question = "Who signs off on the supplier contract?";

    const chat = await askNew(ann, question, "openai/gpt-6-luna");

    await until(() => {
      expect(list.answered(chat)).toBeTruthy();
      expect(provider.titles).toHaveLength(1);
    });
    await until(async () => {
      await expect(listedTitle(ann, chat)).resolves.toBe(seedTitleOf(question));
    });
    expect(provider.titles).toHaveLength(1);
  });

  it("is asked for once, on the first question only: never again for a later one, after a title that failed or a rename to the same words", async () => {
    const ann = await person();
    const provider = await fakeProvider(says("Here it is."), says("Again."));
    // No title queued: the first comes back empty, and the seed stays.
    const list = await followList(ann);
    const question = "What changed in the supplier contract?";

    const chat = await askNew(ann, question);
    await until(() => {
      expect(list.answered(chat)).toBeTruthy();
      expect(provider.titles).toHaveLength(1);
    });
    await ann.api.chats.markRead(chat.id);
    await ann.api.chats.rename(chat.id, seedTitleOf(question));
    await ann.api.chats.send(chat.id, { text: question, model });
    await until(() => {
      expect(provider.requests).toHaveLength(2);
      expect(list.answered(chat)).toBeTruthy();
    });

    expect(provider.titles).toHaveLength(1);
  });

  it("is the only way the small model goes when the admins didn't choose it: a turn that names it is refused", async () => {
    const ann = await person();
    const provider = await fakeProvider(says("Here it is."));
    const chat = await startedChat(ann, "Questions");

    const refused = await outcome(
      ann.api.chats.send(chat.id, {
        text: "Answer on the small model.",
        model: "anthropic/claude-haiku-5-5",
      })
    );

    expect({ refused, sent: provider.requests.length }).toStrictEqual({
      refused: "model.not_allowed",
      sent: 0,
    });
  });

  it("goes to OpenAI's newest generation's cheapest model, never a cheaper older one, and to the default itself where the provider has none cheaper or of its maker", async () => {
    const ann = await person();
    const cases = [
      // GPT-5 nano costs less than GPT-6 Luna, but is of an older generation.
      { chosen: "openai/gpt-6.2-sol", asked: "gpt-6-luna" },
      // Already the small one.
      { chosen: "openai/gpt-6-luna", asked: "gpt-6-luna" },
      // OpenRouter passes the call on to the default's maker: OpenRouter's
      // small model is OpenAI's, so a Mistral default names its own chats.
      {
        chosen: "openrouter/mistralai/mistral-large-2512",
        asked: "mistralai/mistral-large-2512",
      },
    ];
    const asked = [];
    for (const { chosen } of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one provider at a time
      const provider = await fakeProviderFor([chosen], says("Here it is."));
      // oxlint-disable-next-line no-await-in-loop -- see above
      await askNew(ann, `Which model names this chat, with ${chosen}?`, chosen);
      // oxlint-disable-next-line no-await-in-loop -- see above
      await until(() => {
        expect(provider.titles).toHaveLength(1);
      });
      asked.push(modelOf(provider.titles[0]?.body));
    }
    expect(asked).toStrictEqual(cases.map((each) => each.asked));
  });

  it("has a small model for each provider with a catalog: one of its own there, priced, a text model a route speaks", () => {
    const smalls = organizationProviderIds.map((provider) => {
      const named = aiProviders[provider].smallModel;
      const ref = named === undefined ? undefined : parseModelRef(named);
      return {
        provider,
        own: ref?.provider === provider,
        priced: (ref?.catalog.cost.input ?? 0) > 0,
        text: ref?.catalog.input.includes("text") === true,
        routed: ref !== undefined && isRouteApi(ref.catalog.api),
      };
    });
    expect(smalls).toStrictEqual(
      organizationProviderIds.map((provider) => {
        // An OpenAI-compatible endpoint's models are its own, unpriced.
        const has = provider !== "openai-compatible";
        return { provider, own: has, priced: has, text: has, routed: has };
      })
    );
  });

  it("is never asked for past the organization's limit of Grasp's AI: the question is refused, and the chat keeps its seed", async () => {
    const ann = await person();
    const { api: admin } = await signedInApi(idp, "admin");
    const provider = await fakeProvider(says("Here it is."));
    await admin.aiProviders.setSource("grasp");
    const spent = crypto.randomUUID();
    await drizzle(env.DB)
      .insert(modelUsage)
      .values({
        id: spent,
        period: spendMonth(env),
        personId: "grasp-ai-limit-test",
        triggerType: "person",
        model: graspAi.models[0].model,
        credential: "platform",
        feature: "organization",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: graspAi.monthlyLimitUsd,
        estimated: false,
        createdAt: new Date(),
      });
    try {
      const question = "What changed in the supplier contract?";
      const chat = await startedChat(ann, seedTitleOf(question));
      const refused = await outcome(
        ann.api.chats.send(chat.id, {
          text: question,
          model: graspAi.models[0].model,
        })
      );
      expect({
        refused,
        titles: provider.titles.length,
        title: await listedTitle(ann, chat),
      }).toStrictEqual({
        refused: "model.grasp_limit_reached",
        titles: 0,
        title: seedTitleOf(question),
      });
    } finally {
      await admin.aiProviders.setSource("own");
      await drizzle(env.DB).delete(modelUsage).where(eq(modelUsage.id, spent));
    }
  });
});
