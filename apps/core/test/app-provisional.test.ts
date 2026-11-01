import { chatIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { abandonedAfterMs, reapAbandonedApps } from "../src/app-removal.ts";
import { createApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { chatOf, testRunOpening } from "./agent-chat.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// Apps a chat's agent creates (GRA-161): provisional until their first
// version is made current, and reaped once nobody accepted them and
// nobody works on them. From the threat model: reaping something a person
// relies on (an App they made themselves, one made current, one whose
// draft is being written), reaping while an acceptance lands, and a
// reaping that goes unrecorded.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const slow = { timeout: 60_000 };

/** Long enough ago that an untouched provisional App is abandoned. */
const longAgo = () => Date.now() - abandonedAfterMs - 60_000;

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

describe("an App a chat creates", slow, () => {
  it("is reaped once nobody accepted it and its chat's draft lies untouched, recorded by the platform", async () => {
    const builder = await signedInApi(idp, "builder");
    const chat = await chatOf(builder.userId);
    const app = await createApp(
      env,
      acting(builder.userId),
      { name: `Sketch ${unique()}` },
      undefined,
      { workspaceId: chat.id, chatId: chat.chat.id }
    );
    await createdAt(app.id, longAgo());
    // A release it put up for review goes with it.
    await env.DB.prepare("UPDATE apps SET pending_version = 1 WHERE id = ?")
      .bind(app.id)
      .run();
    const events = await auditedDuring(async () => {
      await reapAbandonedApps(env, new Date());
    });
    const row = await env.DB.prepare(
      "SELECT pending_version AS pending FROM apps WHERE id = ?"
    )
      .bind(app.id)
      .first<{ pending: number | null }>();

    expect({
      reaped: events
        .filter(
          ({ action, target }) =>
            action === "app.removed" && target?.id === app.id
        )
        .map(({ actor, detail }) => ({
          actor: actor.type,
          reason: detail?.reason,
        })),
      get: await outcome(builder.api.apps.get(app.id)),
      pending: row?.pending,
    }).toStrictEqual({
      reaped: [{ actor: "system", reason: "provisional_abandoned" }],
      get: "app.not_found",
      pending: null,
    });
  });

  it("reaches an abandoned App behind more than a run's worth of older ones kept for now", async () => {
    const builder = await signedInApi(idp, "builder");
    const chat = await chatOf(builder.userId);
    const origin = { workspaceId: chat.id, chatId: chat.chat.id };
    const drafting: string[] = [];
    for (let at = 0; at < 21; at += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one App at a time
      const made = await createApp(
        env,
        acting(builder.userId),
        { name: `Drafting ${unique()}` },
        undefined,
        origin
      );
      drafting.push(made.id);
      // Older than the abandoned one: looked at first.
      // oxlint-disable-next-line no-await-in-loop -- as above
      await createdAt(made.id, longAgo() - 60_000 + at);
    }
    const abandoned = await createApp(
      env,
      acting(builder.userId),
      { name: `Abandoned ${unique()}` },
      undefined,
      origin
    );
    await createdAt(abandoned.id, longAgo());
    // Their drafts written now: authoring goes on.
    const chatId = chatIdSchema.parse(chat.chat.id);
    await runInDurableObject(chat.stub, (instance) => {
      for (const id of drafting) {
        const run = instance.openCodeRun(chatId, testRunOpening);
        instance.saveDraft(
          chatId,
          id,
          null,
          { "AGENTS.md": "# Draft\n" },
          [],
          0,
          run
        );
      }
    });
    await reapAbandonedApps(env, new Date());

    expect({
      abandoned: await outcome(builder.api.apps.get(abandoned.id)),
      drafting: await outcome(builder.api.apps.get(drafting[0] ?? "")),
    }).toStrictEqual({ abandoned: "app.not_found", drafting: "ok" });
  });

  it("is kept while a person commits to it outside its chat", async () => {
    const builder = await signedInApi(idp, "builder");
    const chat = await chatOf(builder.userId);
    const app = await createApp(
      env,
      acting(builder.userId),
      { name: `Taken over ${unique()}` },
      undefined,
      { workspaceId: chat.id, chatId: chat.chat.id }
    );
    await builder.api.apps.files.commit(
      app.id,
      { "AGENTS.md": "# Mine now\n" },
      "Mine now"
    );
    await createdAt(app.id, longAgo());
    await reapAbandonedApps(env, new Date());

    await expect(outcome(builder.api.apps.get(app.id))).resolves.toBe("ok");
  });

  it("is kept while its draft is being written, once accepted, and when a person made it", async () => {
    const builder = await signedInApi(idp, "builder");
    const chat = await chatOf(builder.userId);
    const origin = { workspaceId: chat.id, chatId: chat.chat.id };
    const authoring = await createApp(
      env,
      acting(builder.userId),
      { name: `Drafting ${unique()}` },
      undefined,
      origin
    );
    const accepted = await createApp(
      env,
      acting(builder.userId),
      { name: `Accepted ${unique()}` },
      undefined,
      origin
    );
    // A person's own App is never provisional.
    const { id: own } = await builder.api.apps.create({
      name: `Own ${unique()}`,
    });
    // Its draft written now: authoring goes on.
    const chatId = chatIdSchema.parse(chat.chat.id);
    await runInDurableObject(chat.stub, (instance) => {
      const run = instance.openCodeRun(chatId, testRunOpening);
      instance.saveDraft(
        chatId,
        authoring.id,
        null,
        { "AGENTS.md": "# Drafting\n" },
        [],
        0,
        run
      );
    });
    // Its first version made current: accepted for good.
    await release(builder, accepted.id, { "AGENTS.md": "# Accepted\n" });
    for (const id of [authoring.id, accepted.id, own]) {
      // oxlint-disable-next-line no-await-in-loop -- one App at a time
      await createdAt(id, longAgo());
    }
    await reapAbandonedApps(env, new Date());
    const provisional = await env.DB.prepare(
      "SELECT provisional_chat_id AS chat FROM apps WHERE id = ?"
    )
      .bind(accepted.id)
      .first<{ chat: string | null }>();

    expect({
      authoring: await outcome(builder.api.apps.get(authoring.id)),
      accepted: await outcome(builder.api.apps.get(accepted.id)),
      own: await outcome(builder.api.apps.get(own)),
      acceptedIsProvisional: provisional?.chat,
    }).toStrictEqual({
      authoring: "ok",
      accepted: "ok",
      own: "ok",
      acceptedIsProvisional: null,
    });
  });
});
