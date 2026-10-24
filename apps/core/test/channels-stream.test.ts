import { describe, expect, it } from "vite-plus/test";

import { chatAgentId } from "../src/chats-rpc.ts";
import { codeStep, pausedReply, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { botConnectorStreamsUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { readCollection } from "./knowledge.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { signedInApi, unique } from "./sign-in.ts";
import {
  member,
  messageFrom,
  post,
  providers,
  reached,
  watched,
} from "./teams-door.ts";

// An answer streamed into a member's private Teams chat as the model
// writes it (src/channels/answer.ts), through Microsoft's own streaming:
// typing activities that carry the text so far, then the whole answer,
// then its sources. Where Teams refuses the stream, typing and the whole
// answer follow as before.

const idp = mockIdp();

watched();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const answer =
  "Parental leave lasts sixteen weeks. You take it in one go, or in two parts, and you tell your manager a month before.";

/** The streamed parts of what Teams was sent in `conversation`, in order. */
const streamedIn = async (conversation: string) => {
  const { activities } = await reached(conversation);
  return activities.filter((activity) =>
    JSON.stringify(activity).includes('"streamType":"streaming"')
  );
};

describe("a member's answer", setUpTime, () => {
  it("streams in order, then ends as the whole answer with its sources", async () => {
    const admin = await signedInApi(idp, "admin");
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const saved = await admin.api.knowledge.saveDocument({
      collectionId,
      path: "leave.md",
      text: "# Parental leave\n\nParental leave lasts sixteen weeks.",
      ifVersion: 0,
    });
    await requestGranted(
      idp,
      admin,
      readCollection(
        { type: "agent", agentId: chatAgentId },
        collectionId,
        `S${unique()}`.toUpperCase()
      )
    );
    const { reply, release } = pausedReply(
      says(`${answer} [Parental leave](grasp:note/${saved.id})`),
      40
    );
    const { teams } = await member(
      idp,
      codeStep(
        `export default async (self, env) => (await env.knowledge.read(${JSON.stringify(saved.id)})).text;`
      ),
      reply
    );

    const posting = post(messageFrom(teams, { text: "How does leave work?" }));
    // Its first words show while the model still writes.
    await expect
      .poll(async () => await streamedIn(teams.conversation), {
        timeout: 15_000,
      })
      .not.toHaveLength(0);
    release();
    await posting;

    const streamed = await streamedIn(teams.conversation);
    const texts = streamed.map(({ text }) => text ?? "");
    expect(answer.startsWith(texts[0] ?? "-")).toBeTruthy();
    // Each update holds the one before it: the answer, in order.
    for (const [index, text] of texts.entries()) {
      expect(text.startsWith(texts[index - 1] ?? "")).toBeTruthy();
    }
    const { activities } = await reached(teams.conversation);
    const messages = activities.filter(({ type }) => type === "message");
    const [whole, sources] = messages.map((each) => JSON.stringify(each));
    expect({
      text: messages[0]?.text,
      final: whole?.includes('"streamType":"final"'),
      aiLabel: whole?.includes("AIGeneratedContent"),
      source: sources?.includes("1. Parental leave"),
      sourceLink: sources?.includes(
        `${clientOrigin}/knowledge/${collectionId}?doc=${saved.id}`
      ),
    }).toStrictEqual({
      text: `${answer} Parental leave`,
      final: true,
      aiLabel: true,
      source: true,
      sourceLink: true,
    });
  });

  it("follows typing as a whole answer when Teams refuses the stream", async () => {
    const { reply, release } = pausedReply(says(answer), 40);
    const { teams } = await member(idp, reply);
    await providers().fetch(botConnectorStreamsUrl, {
      method: "POST",
      body: JSON.stringify({ refuse: teams.conversation }),
    });

    const posting = post(messageFrom(teams, { text: "How does leave work?" }));
    await expect
      .poll(
        async () => {
          const { activities } = await reached(teams.conversation);
          return activities.map(({ type }) => type);
        },
        { timeout: 15_000 }
      )
      .toContain("typing");
    release();
    await posting;

    const { activities } = await reached(teams.conversation);
    const messages = activities
      .filter(({ type }) => type === "message")
      .map((each) => JSON.stringify(each));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(answer);
    await expect(streamedIn(teams.conversation)).resolves.toStrictEqual([]);
  });
});
