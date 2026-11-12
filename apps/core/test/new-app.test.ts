import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { createApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { mockIdp } from "./idp.ts";
import { runMinuteTasks, runQuarterHourTasks } from "./maintenance.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// Apps made by a chat's agent or by a person. Every App stays until a
// person removes it: nothing the platform runs on its own removes one,
// however long it lies untouched.

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

describe("an App, however it was made", slow, () => {
  it("stays with nothing committed, long after it was made", async () => {
    const builder = await signedInApi(idp, "builder");
    // As a chat's agent creates one (agent-builds.ts).
    const byAgent = await createApp(env, acting(builder.userId), {
      name: `Sketch ${unique()}`,
    });
    // As Make something's Build it, or anyone, creates one (`apps.create`).
    const byPerson = await builder.api.apps.create({
      name: `Desk ${unique()}`,
    });
    const made: string[] = [byAgent.id, byPerson.id];
    for (const id of made) {
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
          action === "app.removed" && made.includes(target?.id ?? "")
      ),
      byAgent: await outcome(builder.api.apps.get(byAgent.id)),
      byPerson: await outcome(builder.api.apps.get(byPerson.id)),
    }).toStrictEqual({ removed: [], byAgent: "ok", byPerson: "ok" });
  });
});
