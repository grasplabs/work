import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { createApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { chatAgentId } from "../src/chats-rpc.ts";
import { maxChatsPerPerson } from "../src/workspace.ts";
import { mockIdp } from "./idp.ts";
import { runMinuteTasks, runQuarterHourTasks } from "./maintenance.ts";
import { chatsOf } from "./previews.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// Apps made from a chat: by its agent, or from New App with a chat of
// their own. Every App stays until a person removes it: nothing the
// platform runs on its own removes one, however long it lies untouched.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const slow = { timeout: 60_000 };

/** Long past any time an untouched App could be thought abandoned. */
const monthsAgo = () => Date.now() - 90 * 24 * 3_600_000;

const acting = (userId: string): Acting => ({
  userId,
  role: "builder",
  teams: [],
  staff: false,
});

/** Makes the App look created `at`, as time passing would. */
const createdAt = async (app: string, at: number): Promise<void> => {
  await env.DB.prepare("UPDATE apps SET created_at = ? WHERE id = ?")
    .bind(at, app)
    .run();
};

describe("an App made from a chat", slow, () => {
  it("stays with nothing committed and its chat untouched, long after it was made", async () => {
    const builder = await signedInApi(idp, "builder");
    // As a chat's agent creates one (agent-builds.ts).
    const byAgent = await createApp(env, acting(builder.userId), {
      name: `Sketch ${unique()}`,
    });
    const fromNewApp = await builder.api.chats.newApp({
      name: `Desk ${unique()}`,
      description: "",
    });
    for (const id of [byAgent.id, fromNewApp.appId]) {
      // oxlint-disable-next-line no-await-in-loop -- one App at a time
      await createdAt(id, monthsAgo());
    }
    const events = await auditedDuring(async () => {
      await runMinuteTasks();
      await runQuarterHourTasks();
    });

    expect({
      removed: events.filter(
        ({ action, target }) =>
          action === "app.removed" &&
          [byAgent.id, fromNewApp.appId].includes(target?.id ?? "")
      ),
      byAgent: await outcome(builder.api.apps.get(byAgent.id)),
      fromNewApp: await outcome(builder.api.apps.get(fromNewApp.appId)),
    }).toStrictEqual({ removed: [], byAgent: "ok", fromNewApp: "ok" });
  });

  it("made from New App, comes with its own chat, and is refused to a non-builder", async () => {
    const [builder, user] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
    ]);
    const made = await builder.api.chats.newApp({
      name: `Desk ${unique()}`,
      description: "A desk",
    });
    const ownChat = await builder.api.chats.forApp(made.appId);
    const refused = await outcome(
      user.api.chats.newApp({ name: "Not mine", description: "" })
    );
    const usersChats = await user.api.chats.list();

    expect({
      ownChat: ownChat.id === made.id,
      refused,
      usersChats,
    }).toStrictEqual({
      ownChat: true,
      refused: "role.forbidden",
      usersChats: [],
    });
  });

  it("made from New App, is refused with nothing made when its chat can't be", async () => {
    const builder = await signedInApi(idp, "builder");
    const kept = chatsOf(builder);
    for (let batch = 0; batch < maxChatsPerPerson / 50; batch += 1) {
      // oxlint-disable-next-line no-await-in-loop -- a batch at a time
      await Promise.all(
        Array.from(
          { length: 50 },
          async () => await kept.createChat("Old", builder.userId, chatAgentId)
        )
      );
    }
    const name = `Too many ${unique()}`;

    const refused = await outcome(
      builder.api.chats.newApp({ name, description: "" })
    );
    const listed = await builder.api.apps.list();

    expect({
      refused,
      listed: listed.filter((app) => app.name === name),
    }).toStrictEqual({ refused: "agent.too_many_chats", listed: [] });
  });
});
