import type { AgentDraft } from "@grasp-os/shared/agents";
import type { ChatMessage, ChatUpdate } from "@grasp-os/shared/chat";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { model, personalChatsOf, says, toolStep } from "./agent-chat.ts";
import type { WorkspaceStub } from "./agent-chat.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import type { Answer, FakeProvider } from "./model-provider.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// An agent made from the chat (GRA-1854): the person asks for one in
// their words, the chat's agent drafts it (`draftAgent`), and Make it
// makes it as the card shows it. These start from the ways it can fail:
// an agent made without the person's press, by the draft itself; one made
// for someone who may not have it (one of the company's for someone who
// isn't an admin); access or an audience wider than the card showed; a
// draft made twice, or from a chat that isn't the person's. The model
// provider is the one outside system, faked.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const draftStep = (draft: Record<string, unknown>): Answer =>
  toolStep("draftAgent", draft);

const toolsSchema = z.object({
  tools: z.array(z.object({ name: z.string() })),
});

/** The tools a request offered, by name. */
const offered = (provider: FakeProvider, at: number): string[] =>
  toolsSchema.parse(provider.requests[at]?.body).tools.map(({ name }) => name);

const idle = async (person: Person, chatId: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      const { running } = await person.api.chats.summary(chatId);
      expect(running).toBeFalsy();
    },
    { timeout: 20_000 }
  );
};

const messagesOf = async (
  stub: WorkspaceStub,
  chatId: string,
  personId: string
): Promise<ChatMessage[]> => {
  const updates: ChatUpdate[] = [];
  await stub.watch(chatId, personId, null, async (update: ChatUpdate) => {
    updates.push(update);
    await Promise.resolve();
  });
  await expect.poll(() => updates.length).toBeGreaterThan(0);
  return updates.flatMap(({ messages }) => messages);
};

/** A chat of `person`'s whose agent drafted `draft`, answering on after. */
const draftedChat = async (person: Person, draft: Record<string, unknown>) => {
  const chats = await personalChatsOf(
    person.userId,
    draftStep(draft),
    says("It's made.")
  );
  const chat = await person.api.chats.create("An agent");
  await person.api.chats.send(chat.id, {
    text: "Make me an HR agent that checks incoming mail once a week.",
    model,
  });
  await idle(person, chat.id);
  const messages = await messagesOf(chats.stub, chat.id, person.userId);
  const drafted = messages.findLast(
    (message) =>
      message.role === "assistant" && message.agentDraft !== undefined
  );
  const callId =
    drafted?.role === "assistant" ? drafted.agentDraft?.callId : undefined;
  return { ...chats, chat, callId, messages };
};

/** Change it, on the change `callId` drafted in `chatId`. */
const press = async (person: Person, chatId: string, callId?: string) =>
  await person.api.chats.changeDraftedAgent(chatId, {
    draft: callId ?? "",
    text: "Change it",
    model,
  });

/** The company's agent `id`, as an admin lists it. */
const companyAgent = async (admin: Person, id: string) => {
  const listed = await admin.api.connections.agents();
  return listed.find((agent) => agent.id === id);
};

const hr = (name: string) => ({
  name,
  job: "Checks incoming mail for HR once a week.",
  instructions: "Every Monday, read HR's new mail and sum it up.",
});

describe("an agent made from the chat", { timeout: 120_000 }, () => {
  it("is made for an admin as the card shows it, only once they press Make it, and only once", async () => {
    const admin = await signedInApi(idp, "admin");
    const name = `HR helper ${unique()}`;
    const draft = {
      ...hr(name),
      whose: "company",
      audience: { who: "everyone" },
      classes: ["read-own"],
      schedule: { cron: "0 8 * * 1", opening: "Sum up HR's new mail." },
    } satisfies AgentDraft;
    const { chat, callId, provider } = await draftedChat(admin, draft);
    const before = await admin.api.connections.agents();

    const made = await admin.api.chats.makeDraftedAgent(chat.id, {
      draft: callId ?? "",
      text: "Make it",
      model,
    });
    await idle(admin, chat.id);
    const again = await outcome(
      admin.api.chats.makeDraftedAgent(chat.id, {
        draft: callId ?? "",
        text: "Make it",
        model,
      })
    );
    const settings = await admin.api.connections.agentSettings(made.id);
    const wakes = await admin.api.connections.agentWakes(made.id);
    const events = await allEvents();
    const madeEvent = events.find(
      ({ action, target }) => action === "agent.made" && target?.id === made.id
    );

    expect({
      offered: offered(provider, 0).includes("draftAgent"),
      before: before.some((agent) => agent.name === name),
      made: made.name,
      audience: settings.audience,
      on: settings.classes
        .filter(({ audience }) => audience.who !== "nobody")
        .map(({ toolClass, audience }) => [toolClass, audience.who]),
      wakes: wakes.map(({ cron, opening, personId }) => [
        cron,
        opening,
        personId,
      ]),
      from: madeEvent?.detail?.from,
      again,
    }).toStrictEqual({
      offered: true,
      before: false,
      made: name,
      audience: { who: "everyone" },
      on: [["read-own", "asClass"]],
      wakes: [["0 8 * * 1", "Sum up HR's new mail.", admin.userId]],
      from: "chat",
      again: "agent.draft_not_found",
    });
  });

  it("makes someone who isn't an admin only an agent of their own, refusing one of the company's back to the model", async () => {
    const user = await signedInApi(idp, "user");
    const name = `My helper ${unique()}`;
    const company = await draftedChat(user, {
      ...hr(name),
      whose: "company",
      audience: { who: "everyone" },
    });
    const own = await draftedChat(user, { ...hr(name), whose: "own" });

    const refused = await outcome(
      user.api.chats.makeDraftedAgent(company.chat.id, {
        draft: company.callId ?? "",
        text: "Make it",
        model,
      })
    );
    const made = await user.api.chats.makeDraftedAgent(own.chat.id, {
      draft: own.callId ?? "",
      text: "Make it",
      model,
    });
    // Its turn after Make it ends before another test's model answers.
    await idle(user, own.chat.id);
    const mine = await user.api.connections.ownAgents();

    expect({
      refused,
      made: made.name,
      mine: mine.map((agent) => [agent.name, agent.ownerId]),
    }).toStrictEqual({
      // The tool refused it back to the model: no draft the chat holds.
      refused: "agent.draft_not_found",
      made: name,
      mine: [[name, user.userId]],
    });
  });

  it("makes nothing of a draft whose schedule or teams its page would refuse, leaving it to make again", async () => {
    const admin = await signedInApi(idp, "admin");
    const name = `Too often ${unique()}`;
    const { chat, callId } = await draftedChat(admin, {
      ...hr(name),
      whose: "company",
      schedule: { cron: "* * * * *", opening: "Check again." },
    });

    const tried = await outcome(
      admin.api.chats.makeDraftedAgent(chat.id, {
        draft: callId ?? "",
        text: "Make it",
        model,
      })
    );
    const listed = await admin.api.connections.agents();
    const again = await outcome(
      admin.api.chats.makeDraftedAgent(chat.id, {
        draft: callId ?? "",
        text: "Make it",
        model,
      })
    );

    expect({
      tried,
      made: listed.some((agent) => agent.name === name),
      // Still the chat's to make: refused as before, never "made already".
      again,
    }).toStrictEqual({
      tried: "agent.wake_invalid",
      made: false,
      again: "agent.wake_invalid",
    });
  });

  it("gives the agent exactly the apps its card showed, and makes nothing of a card naming an app the company doesn't offer", async () => {
    const admin = await signedInApi(idp, "admin");
    const name = `With apps ${unique()}`;
    const withApps = await draftedChat(admin, {
      ...hr(name),
      whose: "company",
      apps: [{ source: "native", provider: "google", name: "Gmail" }],
    });
    const made = await admin.api.chats.makeDraftedAgent(withApps.chat.id, {
      draft: withApps.callId ?? "",
      text: "Make it",
      model,
    });
    await idle(admin, withApps.chat.id);
    const apps = await admin.api.connections.agentApps(made.id);
    const other = `Not offered ${unique()}`;
    const notOffered = await draftedChat(admin, {
      ...hr(other),
      whose: "company",
      apps: [{ source: "composio", provider: "nothing", name: "Nothing" }],
    });
    const refused = await outcome(
      admin.api.chats.makeDraftedAgent(notOffered.chat.id, {
        draft: notOffered.callId ?? "",
        text: "Make it",
        model,
      })
    );
    const listed = await admin.api.connections.agents();

    expect({
      apps: apps.map(({ app, state, source }) => [app, state, source]),
      refused,
      madeOther: listed.some((agent) => agent.name === other),
    }).toStrictEqual({
      apps: [["native:google", "on", "person"]],
      refused: "agent.app_unknown",
      madeOther: false,
    });
  });

  it("is never drafted in a turn nobody asked for", async () => {
    const admin = await signedInApi(idp, "admin");
    const { stub, provider, newChat } = await personalChatsOf(
      admin.userId,
      says("Done.")
    );
    const { chat } = await newChat();
    await stub.askUnattended(chat.id, { text: "Weekly check.", model });

    expect(offered(provider, 0)).not.toContain("draftAgent");
  });

  it("isn't made from a draft the chat doesn't hold, nor from another person's chat", async () => {
    const admin = await signedInApi(idp, "admin");
    const other = await signedInApi(idp, "admin");
    const name = `Not made ${unique()}`;
    const { chat, callId } = await draftedChat(admin, {
      ...hr(name),
      whose: "company",
    });
    const listed = await admin.api.connections.agents();

    expect({
      unknown: await outcome(
        admin.api.chats.makeDraftedAgent(chat.id, {
          draft: "call_none",
          text: "Make it",
          model,
        })
      ),
      others: await outcome(
        other.api.chats.makeDraftedAgent(chat.id, {
          draft: callId ?? "",
          text: "Make it",
          model,
        })
      ),
      made: listed.some((agent) => agent.name === name),
    }).toStrictEqual({
      unknown: "agent.draft_not_found",
      others: "agent.chat_not_found",
      made: false,
    });
  });

  describe("a change to an agent drafted in the chat", () => {
    /** A chat of `person`'s whose agent drafted `change`, answering on after. */
    const changedChat = async (
      person: Person,
      change: Record<string, unknown>
    ) => {
      const chats = await personalChatsOf(
        person.userId,
        toolStep("draftAgentChange", change),
        says("It's changed.")
      );
      const chat = await person.api.chats.create("A change");
      await person.api.chats.send(chat.id, {
        text: "Give it the calendar.",
        model,
      });
      await idle(person, chat.id);
      const messages = await messagesOf(chats.stub, chat.id, person.userId);
      const drafted = messages.findLast(
        (message) =>
          message.role === "assistant" && message.agentChange !== undefined
      );
      const callId =
        drafted?.role === "assistant" ? drafted.agentChange?.callId : undefined;
      return { ...chats, chat, callId };
    };

    it("changes the company's agent for an admin as the card shows it, only on Change it, and only once", async () => {
      const admin = await signedInApi(idp, "admin");
      const name = `Claire ${unique()}`;
      const made = await admin.api.connections.makeAgent({
        ...hr(name),
        face: "pen",
        modelRole: null,
      });
      const { chat, callId } = await changedChat(admin, {
        agent: name,
        whose: "company",
        addInstructions: "Also keep the HR calendar.",
        addApps: [{ source: "native", provider: "google", name: "Google" }],
        turnOn: ["read-own"],
      });
      const before = await companyAgent(admin, made.id);

      await press(admin, chat.id, callId);
      await idle(admin, chat.id);
      const again = await outcome(press(admin, chat.id, callId));
      const after = await companyAgent(admin, made.id);
      const apps = await admin.api.connections.agentApps(made.id);
      const settings = await admin.api.connections.agentSettings(made.id);

      expect({
        before: before?.instructions,
        after: [after?.instructions, after?.job],
        apps: apps.map(({ app, state }) => [app, state]),
        on: settings.classes
          .filter(({ audience: { who } }) => who !== "nobody")
          .map(({ toolClass }) => toolClass),
        // Who may ask it was on no card: unchanged.
        audience: settings.audience,
        again,
      }).toStrictEqual({
        before: hr(name).instructions,
        after: [
          `${hr(name).instructions}\n\nAlso keep the HR calendar.`,
          hr(name).job,
        ],
        apps: [["native:google", "on"]],
        on: ["read-own"],
        audience: { who: "nobody" },
        again: "agent.draft_not_found",
      });
    });

    it("changes nothing of an agent changed since the chat drafted the change", async () => {
      const admin = await signedInApi(idp, "admin");
      const name = `Stale ${unique()}`;
      const made = await admin.api.connections.makeAgent({
        ...hr(name),
        face: "pen",
        modelRole: null,
      });
      const { chat, callId } = await changedChat(admin, {
        agent: name,
        whose: "company",
        addInstructions: "Drafted on what it was.",
      });
      await admin.api.connections.changeAgent(made.id, {
        ...hr(name),
        instructions: "Changed on its page meanwhile.",
        face: "pen",
        modelRole: null,
      });

      const tried = await outcome(press(admin, chat.id, callId));
      const after = await companyAgent(admin, made.id);

      expect({ tried, instructions: after?.instructions }).toStrictEqual({
        tried: "agent.draft_stale",
        instructions: "Changed on its page meanwhile.",
      });
    });

    it("changes only an agent the person may change: their own, never another's or the company's", async () => {
      const ann = await signedInApi(idp, "user");
      const ben = await signedInApi(idp, "user");
      const admin = await signedInApi(idp, "admin");
      const bens = `Bens ${unique()}`;
      await ben.api.connections.makeOwnAgent({
        ...hr(bens),
        face: "pen",
        modelRole: null,
      });
      const companys = `Company ${unique()}`;
      await admin.api.connections.makeAgent({
        ...hr(companys),
        face: "pen",
        modelRole: null,
      });
      const others = await changedChat(ann, {
        agent: bens,
        whose: "own",
        addInstructions: "Mine now.",
      });
      const company = await changedChat(ann, {
        agent: companys,
        whose: "company",
        addInstructions: "Mine now.",
      });

      const triedOthers = await outcome(
        press(ann, others.chat.id, others.callId)
      );
      const triedCompany = await outcome(
        press(ann, company.chat.id, company.callId)
      );
      const bensNow = await ben.api.connections.ownAgents();

      expect({
        others: triedOthers,
        // The tool refused it back to the model: no change the chat holds.
        company: triedCompany,
        bens: bensNow.map(({ instructions }) => instructions),
      }).toStrictEqual({
        others: "agent.unknown",
        company: "agent.draft_not_found",
        bens: [hr(bens).instructions],
      });
    });

    it("changes nothing on a card older than a change to the agent's apps, and keeps whether it answers at all as it is", async () => {
      const admin = await signedInApi(idp, "admin");
      const name = `Settings ${unique()}`;
      const made = await admin.api.connections.makeAgent({
        ...hr(name),
        face: "pen",
        modelRole: null,
      });
      await admin.api.connections.setAgentReach(made.id, false, {
        who: "nobody",
      });
      const stale = await changedChat(admin, {
        agent: name,
        whose: "company",
        addApps: [{ source: "native", provider: "google", name: "Google" }],
      });
      // Taken off on its page after the card was drafted.
      await admin.api.connections.setAgentApp(made.id, "native:google", false);
      const tried = await outcome(press(admin, stale.chat.id, stale.callId));
      const reach = await changedChat(admin, {
        agent: name,
        whose: "company",
        audience: { who: "everyone" },
      });
      await press(admin, reach.chat.id, reach.callId);
      await idle(admin, reach.chat.id);
      const apps = await admin.api.connections.agentApps(made.id);
      const settings = await admin.api.connections.agentSettings(made.id);

      expect({
        tried,
        apps: apps.map(({ app, state }) => [app, state]),
        reach: [settings.on, settings.audience],
      }).toStrictEqual({
        tried: "agent.draft_stale",
        apps: [["native:google", "removed"]],
        // Whom it reaches changed; that it answers nobody stayed.
        reach: [false, { who: "everyone" }],
      });
    });

    it("refuses a change to the first agent's apps or access before anything changes, leaving the card to press again", async () => {
      const admin = await signedInApi(idp, "admin");
      const listed = await admin.api.connections.agents();
      const first = listed.at(0);
      const { chat, callId } = await changedChat(admin, {
        agent: first?.name ?? "",
        whose: "company",
        addApps: [{ source: "native", provider: "google", name: "Google" }],
      });

      const tried = await outcome(press(admin, chat.id, callId));
      const again = await outcome(press(admin, chat.id, callId));

      expect({ tried, again }).toStrictEqual({
        tried: "agent.settings_elsewhere",
        again: "agent.settings_elsewhere",
      });
    });
  });
});
