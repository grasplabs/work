import { describe, expect, it } from "vite-plus/test";

import { chatAgentId } from "../src/chats-rpc.ts";
import { codeStep, keptAnswersOf, pausedReply, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { botConnectorStreamsUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { readCollection } from "./knowledge.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { signedInApi, unique } from "./sign-in.ts";
import {
  member,
  mentionIn,
  messageFrom,
  newGroup,
  onGroupRoster,
  post,
  providers,
  reached,
  watched,
} from "./teams-door.ts";

// An answer streamed into a member's private Teams chat as the model
// writes it (src/channels/answer.ts), through Microsoft's own streaming:
// typing activities that carry the text so far, then the whole answer,
// then its sources. Where Teams refuses the stream, typing and the whole
// answer follow as before. What streams, what is posted and what is kept
// are the same words, without the links and addresses the model wrote
// (src/channels/without-links.ts), in a private chat and a group's.

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
      // Not the card offering their own Microsoft 365 (connect-own.ts).
      .filter(
        (activity) => !JSON.stringify(activity).includes("/connect-microsoft")
      )
      .map((each) => JSON.stringify(each));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(answer);
    await expect(streamedIn(teams.conversation)).resolves.toStrictEqual([]);
  });
});

/** An answer the model was steered into writing links and addresses in. */
const linked =
  "Leave lasts sixteen weeks. Read [the policy](https://evil.com/leave?d=secret) or ask hr@acme.com.\n\nTell your manager a month before; www.evil.com/x has more.";

/** `linked`, as the person sees it and Grasp keeps it. */
const cleaned =
  "Leave lasts sixteen weeks. Read the policy or ask hr@acme.com.\n\nTell your manager a month before; has more.";

/** Where an address the model wrote would show. */
const address = /evil/iu;

/** The answer posted whole in `conversation`, as its activity's JSON. */
const postedWhole = async (conversation: string): Promise<string[]> => {
  const { activities } = await reached(conversation);
  return activities
    .filter(({ type }) => type === "message")
    .map((activity) => JSON.stringify(activity))
    .filter(
      (activity) =>
        activity.includes("AdaptiveCard") && activity.includes("sixteen weeks")
    );
};

/** `text` as it stands inside JSON. */
const inJson = (text: string): string => JSON.stringify(text).slice(1, -1);

describe("an answer with links the model wrote", setUpTime, () => {
  it("streams, posts and keeps the same words without them, though one was split between two chunks", async () => {
    // Paused inside the link's address: the model has written half of it.
    const { reply, release } = pausedReply(
      says(linked),
      linked.indexOf("evil.com/leave") + 10
    );
    const { userId, teams } = await member(idp, reply);

    const posting = post(messageFrom(teams, { text: "How does leave work?" }));
    await expect
      .poll(async () => await streamedIn(teams.conversation), {
        timeout: 15_000,
      })
      .not.toHaveLength(0);
    const whilePaused = await streamedIn(teams.conversation);
    release();
    await posting;

    const streamed = await streamedIn(teams.conversation);
    const texts = streamed.map(({ text }) => text ?? "");
    const { activities } = await reached(teams.conversation);
    const final = activities.find((activity) =>
      JSON.stringify(activity).includes('"streamType":"final"')
    );
    expect({
      whilePaused: whilePaused.map(({ text }) => text),
      inOrder: texts.every((text, index) =>
        text.startsWith(texts[index - 1] ?? "")
      ),
      final: final?.text,
      addresses: address.test(JSON.stringify(activities)),
      kept: await keptAnswersOf(userId),
    }).toStrictEqual({
      whilePaused: ["Leave lasts sixteen weeks. Read"],
      inOrder: true,
      final: cleaned,
      addresses: false,
      kept: [[cleaned]],
    });
  });

  it("stops a stream a later chunk would change, and posts the whole answer instead, still without them", async () => {
    // The reference turns into a link only once its definition, at the
    // end, arrives: the first paragraph streamed before changes.
    const referenced =
      "First, ask [your lead].\n\nThen fill in the form and send it.\n\n[your lead]: https://evil.com/lead?d=secret";
    const { reply, release } = pausedReply(
      says(referenced),
      referenced.indexOf("form and")
    );
    const { userId, teams } = await member(idp, reply);

    const posting = post(messageFrom(teams, { text: "How do I start?" }));
    await expect
      .poll(async () => await streamedIn(teams.conversation), {
        timeout: 15_000,
      })
      .not.toHaveLength(0);
    release();
    await posting;

    const streamed = await streamedIn(teams.conversation);
    const { activities } = await reached(teams.conversation);
    const whole = "First, ask your lead.\n\nThen fill in the form and send it.";
    const posted = activities
      .filter(({ type }) => type === "message")
      .map((activity) => JSON.stringify(activity));
    expect({
      streamed: streamed.map(({ text }) => text),
      postedWhole: posted.some((activity) => activity.includes(inJson(whole))),
      addresses: address.test(JSON.stringify(activities)),
      kept: await keptAnswersOf(userId),
    }).toStrictEqual({
      streamed: ["First, ask [your lead].\n\nThen fill in the"],
      postedWhole: true,
      addresses: false,
      kept: [[whole]],
    });
  });

  it("posts and keeps the same words without them where Teams refuses the stream, and in a group chat", async () => {
    const { reply, release } = pausedReply(says(linked), 40);
    const ann = await member(idp, reply, says(linked));
    await providers().fetch(botConnectorStreamsUrl, {
      method: "POST",
      body: JSON.stringify({ refuse: ann.teams.conversation }),
    });
    const group = newGroup();
    await onGroupRoster(group, [{ person: ann.teams }]);

    const posting = post(
      messageFrom(ann.teams, { text: "How does leave work?" })
    );
    await expect
      .poll(
        async () => {
          const { activities } = await reached(ann.teams.conversation);
          return activities.map(({ type }) => type);
        },
        { timeout: 15_000 }
      )
      .toContain("typing");
    release();
    await posting;
    await post(mentionIn(ann.teams, group, "How does leave work?"));

    const [inPrivate, inGroup] = await Promise.all([
      postedWhole(ann.teams.conversation),
      postedWhole(group),
    ]);
    const all = JSON.stringify([
      await reached(ann.teams.conversation),
      await reached(group),
    ]);
    expect({
      inPrivate: inPrivate.map((activity) =>
        activity.includes(inJson(cleaned))
      ),
      inGroup: inGroup.map((activity) => activity.includes(inJson(cleaned))),
      addresses: address.test(all),
      kept: await keptAnswersOf(ann.userId),
    }).toStrictEqual({
      inPrivate: [true],
      inGroup: [true],
      addresses: false,
      kept: [[cleaned], [cleaned]],
    });
  });
});
