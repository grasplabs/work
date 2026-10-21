/**
 * What the admin's Platform page reads beside the client grid
 * (`fetchClientGrid`, `fetchGridLive`): the releases the console
 * imported, and the rollout it shows (`goingOut`) with its targets. All
 * of it is what the console recorded, read with the rollout and release
 * pages' own queries.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { clientGrid } from "../clients/grid.ts";
import { consoleDatabase } from "../db/act.ts";
import { listReleases } from "../releases/queries.ts";
import type { ReleaseSummary } from "../releases/queries.ts";
import { getRollout, listRollouts } from "../rollout/queries.ts";
import type { RolloutView } from "../rollout/queries.ts";
import { goingOut, platformCounts } from "./platform.ts";
import type { PlatformCounts } from "./platform.ts";

/** What the Platform page reads of releases and rollouts. */
export interface PlatformData {
  /** The newest first. */
  releases: ReleaseSummary[];
  /** The rollout going out, or else the latest; null before any. */
  rollout: RolloutView | null;
}

export const platformData = async (envOf: Env): Promise<PlatformData> => {
  const db = consoleDatabase(envOf.DB);
  const [{ releases }, rollouts] = await Promise.all([
    listReleases(db),
    listRollouts(db),
  ]);
  const shown = goingOut(rollouts);
  return {
    releases,
    rollout: shown === null ? null : await getRollout(envOf, shown.id),
  };
};

/** The Platform page's releases and rollout. */
export const fetchPlatform = createServerFn({ method: "GET" }).handler(
  async () => await platformData(env)
);

/** What the admin's sidebar says beside Platform (`platformCounts`). */
export const platformSidebar = async (envOf: Env): Promise<PlatformCounts> => {
  const db = consoleDatabase(envOf.DB);
  const [rows, { releases }, rollouts] = await Promise.all([
    clientGrid(envOf),
    listReleases(db),
    listRollouts(db),
  ]);
  return platformCounts(rows, releases, rollouts);
};

/** What the admin's sidebar says beside Platform. */
export const fetchPlatformSidebar = createServerFn({ method: "GET" }).handler(
  async () => await platformSidebar(env)
);
