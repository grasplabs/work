import { env } from "cloudflare:workers";
import { and, desc, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { auditEvents, channels, clients } from "../src/db/schema.ts";
import {
  pinClient,
  promoteRelease,
  promotionHistory,
  releaseToEdge,
  setClientChannel,
} from "../src/rollout/channels.ts";
import { RolloutError } from "../src/rollout/errors.ts";
import { channelReleases } from "../src/rollout/targets.ts";
import { client, db, staff } from "./hosting.ts";
import { placedRelease } from "./placed.ts";

// What staff and the import change of the desired state
// (src/rollout/channels.ts): fields only, each audited. How it can fail:
// - a release skipping a channel, or a channel unable to go back;
// - Edge taken back by a release imported late;
// - a change landing without its audit event.

/** The refusal's code a promotion answers, or null when it went through. */
const promoting = async (
  channel: "edge" | "beta" | "stable",
  releaseId: string
): Promise<string | null> => {
  try {
    await promoteRelease(env, staff, { channel, releaseId });
    return null;
  } catch (error) {
    if (error instanceof RolloutError) {
      return error.code;
    }
    throw error;
  }
};

/** The audit events of `action` about client `clientId`, oldest first. */
const eventsOf = async (clientId: string, action: string) =>
  await db
    .select({ target: auditEvents.target, detail: auditEvents.detail })
    .from(auditEvents)
    .where(
      and(eq(auditEvents.clientId, clientId), eq(auditEvents.action, action))
    )
    .orderBy(desc(auditEvents.at));

describe("changing the desired state", () => {
  beforeEach(async () => {
    await db.delete(channels);
  });

  it("takes a release Edge, then Beta, then Stable, and a channel back only to a release it had", async () => {
    const first = await placedRelease("feat(core): first");
    const second = await placedRelease("feat(core): second");
    await releaseToEdge(env, [first]);

    const skipping = await promoting("stable", first);
    const toBeta = await promoting("beta", first);
    const toStable = await promoting("stable", first);
    await releaseToEdge(env, [second]);
    await promoteRelease(env, staff, { channel: "beta", releaseId: second });
    const back = await promoting("beta", first);
    const again = await promoting("beta", first);

    expect({
      skipping,
      toBeta,
      toStable,
      back,
      again,
      releases: await channelReleases(db),
    }).toStrictEqual({
      skipping: "promotion_not_allowed",
      toBeta: null,
      toStable: null,
      back: null,
      // It points at that release already.
      again: "promotion_not_allowed",
      releases: { edge: second, beta: first, stable: first },
    });
  });

  it("records every change of a channel, a rollback marked as one, and leaves Edge on a newer release than one imported late", async () => {
    const first = await placedRelease("feat(core): first");
    const second = await placedRelease("feat(core): second");
    await releaseToEdge(env, [second]);
    await releaseToEdge(env, [first]);
    await db.delete(channels);
    await releaseToEdge(env, [first]);
    await releaseToEdge(env, [second]);
    await promoteRelease(env, staff, { channel: "edge", releaseId: first });

    const [latest, before] = await promotionHistory(db, [first, second]);
    const { edge } = await channelReleases(db);

    expect({
      edge,
      latest: latest && {
        channel: latest.channel,
        releaseId: latest.releaseId,
        from: latest.from,
        back: latest.back,
        actor: latest.actor,
      },
      before: before && { releaseId: before.releaseId, actor: before.actor },
    }).toStrictEqual({
      edge: first,
      latest: {
        channel: "edge",
        releaseId: first,
        from: second,
        back: true,
        actor: staff.email,
      },
      before: { releaseId: second, actor: "system" },
    });
  });

  it("pins, unpins and moves a client as fields of its own, each audited once", async () => {
    const release = await placedRelease("feat(core): pinned to");
    const clientId = await client();

    await pinClient(env, staff, { clientId, releaseId: release });
    await pinClient(env, staff, { clientId, releaseId: release });
    await setClientChannel(env, staff, { clientId, channel: "beta" });
    await pinClient(env, staff, { clientId, releaseId: null });
    const row = await db
      .select({ channel: clients.channel, pinned: clients.pinnedReleaseId })
      .from(clients)
      .where(eq(clients.id, clientId))
      .get();
    const actions = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          inArray(auditEvents.action, [
            "client.pin",
            "client.unpin",
            "client.channel",
          ])
        )
      );

    const pins = await eventsOf(clientId, "client.pin");

    expect({
      row,
      actions: actions.map(({ action }) => action).toSorted(),
      pins: pins.length,
    }).toStrictEqual({
      row: { channel: "beta", pinned: null },
      actions: ["client.channel", "client.pin", "client.unpin"],
      pins: 1,
    });
  });
});
