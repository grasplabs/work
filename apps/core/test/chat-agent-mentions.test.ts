import type { ChatUpdate } from "@grasp-os/shared/chat";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { model, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider, fakeProvider } from "./model-provider.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// Agents mentioned in a question (`ChatQuestion.mentions`, kind `agent`):
// each agent the person addresses answers in turn, as itself. These start
// from the ways it can fail: an agent answering that the person may not
// ask, by naming its ID; an answer given as one agent but told another's
// instructions; a next agent not seeing what was answered before it, or
// the person seeing their question twice; an answer not saying whose it
// is; a next question going to an agent nobody addressed.

const idp = mockIdp();

const slow = { timeout: 60_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** Follows a chat, keeping every update. */
const follow = async (person: Person, chatId: string) => {
  const updates: ChatUpdate[] = [];
  await person.api.chats.watch(chatId, null, (update) => {
    updates.push(update);
  });
  return {
    messages: () => {
      const byId = new Map(
        updates.flatMap(({ messages }) => messages).map((m) => [m.id, m])
      );
      return [...byId.values()].toSorted((a, b) => a.id - b.id);
    },
  };
};

/** Waits until the agent has stopped working on `chatId`. */
const settled = async (person: Person, chatId: string) => {
  await vi.waitFor(
    async () => {
      const chats = await person.api.chats.list();
      expect(chats.find(({ id }) => id === chatId)?.running).toBeFalsy();
    },
    { timeout: 20_000 }
  );
};

/** An agent everyone reaches, told `instructions`. */
const agentFor = async (admin: Person, name: string, instructions: string) => {
  const agent = await admin.api.connections.makeAgent({
    name,
    face: "pen",
    job: `${name}'s job.`,
    instructions,
    modelRole: null,
  });
  await admin.api.connections.setAgentReach(agent.id, true, {
    who: "everyone",
  });
  return agent;
};

describe("agents mentioned in a question", slow, () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM agents"),
      env.DB.prepare("DELETE FROM agent_reach"),
      env.DB.prepare("DELETE FROM agent_tool_classes"),
    ]);
  });

  it("answer each in turn, as themselves, each after the answers before it, and the chat goes on with the last", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const claire = await agentFor(admin, "Claire", "Speak of invoices.");
    const pat = await agentFor(admin, "Pat", "Speak of leave.");
    const provider = await fakeProvider(
      says("Claire: two invoices are late."),
      says("Pat: nobody is on leave."),
      says("Pat again.")
    );
    const chat = await ann.api.chats.create("Monday");
    const followed = await follow(ann, chat.id);

    await ann.api.chats.send(chat.id, {
      text: "@Claire @Pat what should I know this week?",
      model,
      mentions: [
        { kind: "agent", id: claire.id },
        { kind: "agent", id: pat.id },
      ],
    });
    await settled(ann, chat.id);
    await ann.api.chats.send(chat.id, { text: "And tomorrow?", model });
    await settled(ann, chat.id);

    const asked = provider.requests.map(({ body }) => JSON.stringify(body));
    const shown = followed.messages();
    const listed = await ann.api.chats.list();
    const summary = listed.find(({ id }) => id === chat.id);
    expect({
      // Each request is told the agent it answers as, and its own words.
      asClaire: [
        asked[0]?.includes("You answer here as Claire"),
        asked[0]?.includes("Speak of invoices."),
        asked[0]?.includes("Speak of leave."),
      ],
      asPat: [
        asked[1]?.includes("You answer here as Pat"),
        asked[1]?.includes("Speak of leave."),
        asked[1]?.includes("Speak of invoices."),
        // After Claire's answer, and asked to answer as itself.
        asked[1]?.includes("Claire: two invoices are late."),
        asked[1]?.includes("The person addressed you too"),
      ],
      // A question that addresses none goes to the last that answered.
      next: asked[2]?.includes("You answer here as Pat"),
      // The person sees their question once, and whose each answer is.
      shown: shown.flatMap((message) => {
        if (message.role === "user") {
          return [["user", message.text]];
        }
        return message.role === "assistant"
          ? [["assistant", message.agentId, message.text]]
          : [];
      }),
      chatAgent: summary?.agentId,
    }).toStrictEqual({
      asClaire: [true, true, false],
      asPat: [true, true, false, true, true],
      next: true,
      shown: [
        ["user", "@Claire @Pat what should I know this week?"],
        ["assistant", claire.id, "Claire: two invoices are late."],
        ["assistant", pat.id, "Pat: nobody is on leave."],
        ["user", "And tomorrow?"],
        ["assistant", pat.id, "Pat again."],
      ],
      chatAgent: pat.id,
    });
  });

  it("stop at a next agent that can't answer, saying why on the chat, with nothing left waiting", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const claire = await agentFor(admin, "Claire", "Speak of invoices.");
    const pat = await agentFor(admin, "Pat", "Speak of leave.");
    let paused = false;
    // An admin pauses Pat while Claire answers.
    const provider = await answeringProvider(async () => {
      if (!paused) {
        paused = true;
        await admin.api.connections.setAgentPaused(pat.id, true);
        return says("Claire: two invoices are late.");
      }
      return says("Pat should not answer.");
    });
    const chat = await ann.api.chats.create("Monday");
    const updates: ChatUpdate[] = [];
    await ann.api.chats.watch(chat.id, null, (update) => {
      updates.push(update);
    });

    await ann.api.chats.send(chat.id, {
      text: "@Claire @Pat what should I know?",
      model,
      mentions: [
        { kind: "agent", id: claire.id },
        { kind: "agent", id: pat.id },
      ],
    });
    await settled(ann, chat.id);
    await vi.waitFor(() => {
      expect(updates.at(-1)?.stopped).toBeTruthy();
    });
    const listed = await ann.api.chats.list();

    expect({
      asked: provider.requests.length,
      stopped: updates.at(-1)?.stopped,
      // The chat stays with the agent that answered.
      chatAgent: listed.find(({ id }) => id === chat.id)?.agentId,
    }).toStrictEqual({
      asked: 1,
      stopped:
        "This agent is paused, so it doesn't answer now. An admin can turn it back on.",
      chatAgent: claire.id,
    });
  });

  it("are only agents the person may ask: any other is refused as one the company doesn't have, and nothing is asked", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const hidden = await admin.api.connections.makeAgent({
      name: "Hidden",
      face: "pen",
      job: "",
      instructions: "",
      modelRole: null,
    });
    const paused = await agentFor(admin, "Paused", "");
    await admin.api.connections.setAgentPaused(paused.id, true);
    const bens = await ben.api.connections.makeOwnAgent({
      name: "Scribe",
      face: "pen",
      job: "",
      instructions: "",
      modelRole: null,
    });
    const provider = await fakeProvider(says("Should not be asked."));
    const chat = await ann.api.chats.create("Monday");

    const tried = async (id: string) =>
      await outcome(
        ann.api.chats.send(chat.id, {
          text: "Hello?",
          model,
          mentions: [{ kind: "agent", id }],
        })
      );
    expect({
      hidden: await tried(hidden.id),
      paused: await tried(paused.id),
      theirs: await tried(bens.id),
      nobody: await tried("agent-nobody-made"),
      asked: provider.requests.length,
    }).toStrictEqual({
      hidden: "agent.unknown",
      paused: "agent.unknown",
      theirs: "agent.unknown",
      nobody: "agent.unknown",
      asked: 0,
    });
  });
});
