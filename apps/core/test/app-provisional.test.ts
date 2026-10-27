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
    const events = await auditedDuring(async () => {
      await reapAbandonedApps(env, new Date());
    });

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
    }).toStrictEqual({
      reaped: [{ actor: "system", reason: "provisional_abandoned" }],
      get: "app.not_found",
    });
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
