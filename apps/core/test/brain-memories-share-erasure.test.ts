import { brainOf, recallBudgetMax } from "@grasp-os/brain-next/contract";
import type { BrainShare } from "@grasp-os/shared/brain-memories";
import type { ChatMessage } from "@grasp-os/shared/chat";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { organizationId } from "../src/auth/auth.ts";
import {
  brainExportFile,
  brainExportStatus,
  recallAs,
  rememberAs,
  startBrainExport,
  workBrain,
} from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { personalChatsOf, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { finishedByTheClock } from "./brain-next-own-store.ts";
import { mockIdp } from "./idp.ts";
import { noProducers } from "./no-producers.ts";
import { signedInApi } from "./sign-in.ts";

// Erasing a member who shared memories (GRA-1815, with GRA-1747's erasure
// of the shared store): each copy is in her own word (her the speaker),
// which her erasure takes, so a copy she shared with a team or everyone
// goes with her: no colleague finds it in recall, Sources search or the
// Memories page, no export started after holds it, nobody's list of what
// they shared names it, and a colleague's chat that cited it before never
// sends it to the model again (its history pins: the run that read it is
// withheld from every later request).

const idp = mockIdp();

type Signed = Awaited<ReturnType<typeof signedInApi>>;

/** A team of `members`, as an admin makes one. */
const teamOf = async (...members: string[]): Promise<string> => {
  const id = crypto.randomUUID();
  const db = drizzle(env.DB);
  await db
    .insert(teams)
    .values({ id, name: `Team ${id}`, organizationId, createdAt: new Date() });
  await db.insert(teamMembers).values(
    members.map((userId) => ({
      id: crypto.randomUUID(),
      teamId: id,
      userId,
      createdAt: new Date(),
    }))
  );
  return id;
};

/** A word of letters only, as recall finds one. */
const word = (): string =>
  `w${crypto.randomUUID().replaceAll("-", "").replaceAll(/\d/gu, "")}`.slice(
    0,
    14
  );

/** Anna's own fact about customer `name`, shared with `audience`: the copy. */
const sharedBy = async (
  anna: Signed,
  name: string,
  audience: BrainShare["audience"]
) => {
  const statement = `${name} renews in March`;
  const { memory, entity } = await rememberAs(env, anna.userId, {
    change: crypto.randomUUID(),
    about: { kind: "customer", names: [name] },
    type: "fact",
    statement,
    quote: statement,
  });
  const copy = await anna.api.brainMemories.publish({
    memory: { entity, memory },
    shown: {
      about: name,
      value: null,
      statement,
      validFrom: null,
      validUntil: null,
    },
    audience,
    change: crypto.randomUUID(),
  });
  if (copy === null) {
    throw new Error("Shared nothing");
  }
  return { ...copy, name, statement };
};

/** The chat's messages as its person's page gets them when they open it. */
const opened = async (person: Signed, chatId: string) => {
  const messages: ChatMessage[] = [];
  const subscription = await person.api.chats.watch(chatId, null, (update) => {
    messages.push(...update.messages);
  });
  try {
    return await vi.waitFor(
      () => {
        expect(messages.at(-1)?.role).toBe("assistant");
        return messages;
      },
      { timeout: 10_000 }
    );
  } finally {
    subscription[Symbol.dispose]();
  }
};

/** What each step's result of `messages` says. */
const resultsOf = (messages: readonly ChatMessage[]): string[] =>
  messages.flatMap((message) =>
    message.role === "result" ? [message.text] : []
  );

/** Every line of a company export started now, once written. */
const exportLines = async (): Promise<string[]> => {
  const { id } = await startBrainExport(env);
  for (let ticks = 0; ticks < 20; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    await workBrain(env, new Date(), noProducers);
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    const status = await brainExportStatus(env, { id });
    if (status?.state !== "writing") {
      break;
    }
  }
  const status = await brainExportStatus(env, { id });
  if (status?.state !== "done") {
    throw new Error("The export was not written in 20 ticks");
  }
  const files = await Promise.all(
    status.files.map(
      async (file) => (await brainExportFile(env, { id, file })) ?? ""
    )
  );
  return files.join("\n").split("\n");
};

describe("erasing a member who shared memories", { timeout: 180_000 }, () => {
  it("takes every copy she shared, with a team and with everyone, from everything colleagues read", async () => {
    const admin = await signedInApi(idp, "admin");
    const [anna, ben, cas, dora] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const team = await teamOf(anna.userId, ben.userId, cas.userId);
    const toTeam = await sharedBy(anna, `Teamco ${word()}`, { team });
    const toAll = await sharedBy(anna, `Allco ${word()}`, "company");
    const copies = [toTeam, toAll];
    const ids = new Set(copies.map(({ memory }) => memory));

    // Ben's own chat cites the team copy before her erasure.
    const chats = await personalChatsOf(
      ben.userId,
      says("Noted."),
      says("Ok.")
    );
    await requestGranted(idp, admin, {
      subject: chats.agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const { chat, ask } = await chats.newChat();
    await ask(`What about ${toTeam.name}?`);
    const citedBefore = resultsOf(await opened(ben, chat.id)).some((text) =>
      text.includes(toTeam.statement)
    );

    /** What `person` finds of the copies through every way they read. */
    const found = async (person: Signed) => {
      const recalled = await Promise.all(
        copies.map(
          async ({ name }) =>
            await recallAs(env, person.userId, {
              question: name,
              budget: { tokens: recallBudgetMax },
              personal: true,
            })
        )
      );
      const searched = await Promise.all(
        copies.map(
          async ({ name }) => await person.api.brainSources.search(name)
        )
      );
      const pages = await Promise.all(
        copies.map(
          async ({ entity }) =>
            await person.api.brainMemories.memories({
              store: "shared",
              id: entity,
            })
        )
      );
      const entities = await person.api.brainMemories.entities("customer");
      return {
        recall: recalled
          .flatMap(({ memories }) => memories)
          .filter(({ memory }) => ids.has(memory)).length,
        search: searched
          .flatMap(({ memories }) => memories)
          .filter(({ id }) => ids.has(id)).length,
        page: pages.flatMap(({ memories }) => memories).length,
        names: entities.entities.filter(({ name }) =>
          copies.some((copy) => copy.name === name)
        ).length,
      };
    };
    const before = { ben: await found(ben), dora: await found(dora) };

    await admin.api.members.remove(anna.userId);
    await admin.api.members.erase(anna.userId, String(anna.person.name));
    await finishedByTheClock(anna.userId);
    const erasure = await admin.api.members.erasure(anna.userId);

    const lines = await exportLines();
    const lists = await Promise.all(
      [ben, cas, dora].map(async (person) => {
        const page = await person.api.brainMemories.shared();
        return page.memories.filter(({ id }) => ids.has(id)).length;
      })
    );
    // What the store still holds of her word: nothing to list, and
    // nothing left for a take back to matter to.
    const store = brainOf(inJurisdiction(env, env.BRAIN_STORE));
    const herWord = await store.listWritten({
      writer: anna.userId,
      reader: { person: anna.userId, groups: [`team:${team}`, "company"] },
    });
    const takeBack = await store.retireWritten({
      memory: toTeam.memory,
      writer: anna.userId,
      change: crypto.randomUUID(),
    });
    const sentAfter = chats.provider.requests.length;
    await ask("Thanks, and what else is new?");
    const sentNext = JSON.stringify(
      chats.provider.requests.slice(sentAfter).map(({ body }) => body)
    );

    expect({
      completed: erasure.erasure?.completedAt !== null,
      before,
      citedBefore,
      after: { ben: await found(ben), dora: await found(dora) },
      exported: lines.filter(
        (line) =>
          line.includes(anna.userId) ||
          copies.some(
            ({ memory, statement }) =>
              line.includes(memory) || line.includes(statement)
          )
      ),
      lists,
      herWord: herWord.memories,
      takeBack,
      sent: sentNext.includes(toTeam.statement),
    }).toStrictEqual({
      completed: true,
      before: {
        ben: { recall: 2, search: 2, page: 2, names: 2 },
        dora: { recall: 1, search: 1, page: 1, names: 1 },
      },
      citedBefore: true,
      after: {
        ben: { recall: 0, search: 0, page: 0, names: 0 },
        dora: { recall: 0, search: 0, page: 0, names: 0 },
      },
      exported: [],
      lists: [0, 0, 0],
      herWord: [],
      takeBack: null,
      sent: false,
    });
  });
});
