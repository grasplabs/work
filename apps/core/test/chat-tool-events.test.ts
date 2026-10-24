import type { ChatToolEvent, ChatUpdate } from "@grasp-os/shared/chat";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { codeStep, model, pointAtGateway, says } from "./agent-chat.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

// The calls a chat's code makes to its agent's APIs, as the chat streams
// them to the page that follows it (`ChatToolEvent`): one line per call,
// under the code step that made it. The ways it can fail come first: a
// call's line carries what it read; a refused call shows as done; a line
// lands under another step, or comes twice; a page that opens the chat
// later, or after a restart, misses the lines of the steps before.

const idp = mockIdp();

/** A member signed in on a connection of their own, and their chats. */
const person = async () => {
  const signedIn = await signedInApi(idp, "user");
  return { ...signedIn, chats: signedIn.api.chats };
};
type Person = Awaited<ReturnType<typeof person>>;

/** The object that holds `someone`'s chats. */
const objectOf = ({ userId }: { userId: string }) =>
  workspace(env, personalWorkspaceId(userId));

/** Points `someone`'s chats at a fake gateway that answers `replies`. */
const answering = async (
  someone: { userId: string },
  ...replies: GatewayReply[]
) => {
  await pointAtGateway(objectOf(someone), fakeGateway(...replies));
};

/** Follows a chat, keeping every update. */
const follow = async (chats: Person["chats"], chatId: string) => {
  const updates: ChatUpdate[] = [];
  const subscription = await chats.watch(chatId, null, (update) => {
    updates.push(update);
  });
  return {
    updates,
    subscription,
    tools: (): ChatToolEvent[] => updates.flatMap(({ tools = [] }) => tools),
    messages: () => updates.flatMap(({ messages }) => messages),
  };
};
type Follower = Awaited<ReturnType<typeof follow>>;

/** Waits until the follower's chat has answered. */
const answered = async (follower: Follower) => {
  await vi.waitFor(
    () => {
      expect({
        running: follower.updates.at(-1)?.running,
        last: follower.messages().at(-1)?.role,
      }).toStrictEqual({ running: false, last: "assistant" });
    },
    { timeout: 10_000 }
  );
};

/** What a page shows of a call: everything but when. */
const line = ({ at: _at, ...event }: ChatToolEvent) => event;

/** The code step whose calls these tests follow. */
const stepCode = `export default async (self, env) => {
  const attachments = await env.chat.attachments();
  const workflows = await env.workflows.list();
  const found = await env.knowledge.search("the secret parental leave policy");
  let refused = false;
  try {
    await env.knowledge.read("doc-that-is-not-there");
  } catch {
    refused = true;
  }
  return { attachments: attachments.length, workflows: workflows.length, hits: found.hits.length, refused };
};`;

describe("a chat's tool lines", () => {
  it("show each call of a code step as it ends, under that step, with identifiers and counts and never what it read", async () => {
    const ann = await person();
    await answering(ann, codeStep(stepCode), says("Nothing on that."));
    const chat = await ann.chats.create("Leave");
    const follower = await follow(ann.chats, chat.id);

    await ann.chats.send(chat.id, { text: "What is our leave policy?", model });
    await answered(follower);

    const result = follower
      .messages()
      .find((message) => message.role === "result");
    const callId = result?.role === "result" ? result.callId : "none";
    const tools = follower.tools();
    expect({
      result: result?.text,
      lines: tools.map(line),
      // Each came once, in the order the code made them.
      ids: tools.map(({ id }) => id),
      // The search's words are the person's question: never on a line.
      leaked: JSON.stringify(tools).includes("secret"),
      // Refused with an error code, never a message.
      code: /^[a-z_]+\.[a-z_]+$/u.test(tools[3]?.reason ?? ""),
      unique: new Set(tools.map(({ id }) => id)).size,
    }).toStrictEqual({
      result: `Returned:\n${JSON.stringify({ attachments: 0, workflows: 0, hits: 0, refused: true })}`,
      lines: [
        {
          id: tools[0]?.id,
          callId,
          method: "chat.attachments",
          target: null,
          summary: { attachments: 0 },
          outcome: "ok",
          reason: null,
        },
        {
          id: tools[1]?.id,
          callId,
          method: "workflows.list",
          target: null,
          summary: { workflows: 0 },
          outcome: "ok",
          reason: null,
        },
        {
          id: tools[2]?.id,
          callId,
          method: "knowledge.search",
          target: null,
          summary: { hits: 0 },
          outcome: "ok",
          reason: null,
        },
        {
          id: tools[3]?.id,
          callId,
          method: "knowledge.read",
          target: null,
          summary: {},
          outcome: "refused",
          reason: tools[3]?.reason,
        },
      ],
      ids: tools.map(({ id }) => id).toSorted((a, b) => a - b),
      leaked: false,
      code: true,
      unique: 4,
    });
  });

  it("are kept with the chat: a page that opens it later, or after a restart, gets every one, and none once it's deleted", async () => {
    const ann = await person();
    await answering(
      ann,
      codeStep(
        "export default async (self, env) => (await env.chat.attachments()).length;"
      ),
      says("None."),
      codeStep(
        "export default async (self, env) => (await env.workflows.list()).length;"
      ),
      says("None either.")
    );
    const chat = await ann.chats.create("Kept");
    const first = await follow(ann.chats, chat.id);
    await ann.chats.send(chat.id, { text: "Anything attached?", model });
    await answered(first);
    await ann.chats.send(chat.id, { text: "Any workflows?", model });
    await vi.waitFor(
      () => {
        expect(first.tools()).toHaveLength(2);
      },
      { timeout: 10_000 }
    );
    await answered(first);
    const streamed = first.tools();
    const steps = first
      .messages()
      .flatMap((message) =>
        message.role === "result" ? [message.callId] : []
      );

    // Opened later, it comes in the first update with the messages.
    const later = await follow(ann.chats, chat.id);
    await vi.waitFor(
      () => {
        expect(later.updates).not.toHaveLength(0);
      },
      { timeout: 10_000 }
    );
    first.subscription[Symbol.dispose]();
    later.subscription[Symbol.dispose]();
    await evictDurableObject(objectOf(ann));
    const restarted = await follow(ann.chats, chat.id);
    await vi.waitFor(
      () => {
        expect(restarted.updates).not.toHaveLength(0);
      },
      { timeout: 10_000 }
    );
    restarted.subscription[Symbol.dispose]();
    await ann.chats.remove(chat.id);

    expect({
      methods: streamed.map(({ method, callId }) => [method, callId]),
      later: later.updates[0]?.tools,
      restarted: restarted.updates[0]?.tools,
    }).toStrictEqual({
      methods: [
        ["chat.attachments", steps[0]],
        ["workflows.list", steps[1]],
      ],
      later: streamed,
      restarted: streamed,
    });
    // Deleted with it.
    await expect(
      runInDurableObject(objectOf(ann), (_instance, state) =>
        state.storage.sql
          .exec(
            "SELECT count(*) AS kept FROM chat_tool_events WHERE chat_id = ?",
            chat.id
          )
          .one()
      )
    ).resolves.toStrictEqual({ kept: 0 });
  });
});
