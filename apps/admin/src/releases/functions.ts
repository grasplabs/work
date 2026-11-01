/**
 * The release pages' server functions: read-only, behind the Access check
 * every request passes (src/access.ts). Each release comes with the
 * channels it has been on, from the audit log (src/rollout/channels.ts).
 */
import { releaseIdSchema } from "@grasp-os/shared/release-id";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { adminDatabase } from "../db/act.ts";
import { clients, clientWorkers } from "../db/schema.ts";
import type { Channel } from "../db/schema.ts";
import { promotionHistory } from "../rollout/channels.ts";
import { getRelease, listReleases } from "./queries.ts";

export const fetchReleases = createServerFn({ method: "GET" }).handler(
  async () => {
    const db = adminDatabase(env.DB);
    const listed = await listReleases(db);
    // Every promotion, unfiltered: D1 binds at most 100 parameters.
    const history = await promotionHistory(db);
    const channelsOn: Record<string, Channel[]> = {};
    for (const { releaseId, channel } of history) {
      const on = channelsOn[releaseId] ?? [];
      if (!on.includes(channel)) {
        channelsOn[releaseId] = [...on, channel];
      }
    }
    return { ...listed, channelsOn };
  }
);

export const fetchRelease = createServerFn({ method: "GET" })
  .validator(z.object({ id: releaseIdSchema }))
  .handler(async ({ data }) => {
    const db = adminDatabase(env.DB);
    const release = await getRelease(db, data.id);
    if (release === null) {
      return null;
    }
    // The companies whose core runs it: the one their people meet.
    const running = await db
      .select({ id: clients.id, name: clients.name })
      .from(clientWorkers)
      .innerJoin(clients, eq(clients.id, clientWorkers.clientId))
      .where(
        and(
          eq(clientWorkers.releaseId, data.id),
          eq(clientWorkers.worker, "core"),
          eq(clients.status, "active")
        )
      );
    return {
      ...release,
      history: await promotionHistory(db, [data.id]),
      running: running.toSorted((a, b) => a.name.localeCompare(b.name)),
    };
  });
