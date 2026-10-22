/**
 * The admin's `platforms` tool, as the console answers it over its MCP
 * (src/admin/mcp.ts): every company's own Grasp and the release going out,
 * worked out by the Platform page's own model (src/admin/platform.ts) from
 * what the page reads (the client grid, its live columns, the releases and
 * the rollout), so a chat and the page never disagree. Under decision D5
 * on GRA-656, its text names each company by its id; the names are given
 * only as data, in `names`.
 */
import type { AdminToolAnswer } from "@grasp-os/shared/admin/admin-tools";

import { clientGrid, gridLive } from "../clients/grid.ts";
import type { LiveOptions } from "../clients/grid.ts";
import { platformData } from "./platform-data.ts";
import { companiesOf, errorRateOf, ringsOf } from "./platform.ts";
import type { PlatformNeed } from "./platform.ts";

/** A need in a few words, as the Platform page names it. */
const needWords = (need: PlatformNeed): string => {
  switch (need.kind) {
    case "failed": {
      return `its last deploy of ${need.releaseId} failed`;
    }
    case "drift": {
      return `what runs differs from what the console made live (${need.drift.replace("_", " ")})`;
    }
    case "errors": {
      return `${Math.round(need.rate * 1000) / 10}% of yesterday's requests failed`;
    }
    case "behind": {
      return `${need.releases} releases behind`;
    }
    default: {
      return need satisfies never;
    }
  }
};

/** A share as a percentage with one decimal, or "no" when unknown. */
const rateWords = (rate: number | null): string =>
  rate === null ? "no" : `${Math.round(rate * 1000) / 10}%`;

/**
 * Every company's platform and the release going out, as of `now`, in
 * words by id and as data.
 */
export const platformsAnswer = async (
  env: Env,
  now: Date,
  live?: LiveOptions
): Promise<AdminToolAnswer> => {
  const [rows, platform, liveColumns] = await Promise.all([
    clientGrid(env),
    platformData(env),
    gridLive(env, now, live),
  ]);
  const companies = companiesOf(rows, liveColumns, platform.releases);
  const lines = companies.map(({ row, standing, needs }) => {
    if (row.status === "provisioning") {
      return `- ${row.id}: being set up; ring ${row.ring}.`;
    }
    const day = liveColumns[row.id]?.day;
    const runs = row.release ?? "nothing yet";
    const pinned = row.pinnedReleaseId === null ? "" : " (pinned)";
    const look =
      needs.length > 0
        ? `; needs a look: ${needs.map(needWords).join("; ")}`
        : "";
    const traffic =
      day === undefined || day === null
        ? "yesterday's requests not read"
        : `${day.requests} requests yesterday, ${rateWords(errorRateOf(liveColumns[row.id]))} errors`;
    return `- ${row.id}: ${standing}; ring ${row.ring}; runs ${runs}${pinned}; ${traffic}${look}.`;
  });
  const { rollout } = platform;
  const rings =
    rollout === null
      ? []
      : ringsOf(rollout, rollout.targets).map((ring) => ({
          ring: ring.ring,
          state: ring.state,
          done: ring.done,
          of: ring.targets.length,
        }));
  const goingOut =
    rollout === null
      ? "No release has gone out yet."
      : `${rollout.status === "running" || rollout.status === "waiting" ? "Going out now" : "The last rollout"}: ${rollout.releaseId ?? "settings only"}, ${rollout.status}${rollout.status === "waiting" ? " for someone at Grasp to approve the next ring" : ""}.${rings.map((ring) => ` Ring ${ring.ring}: ${ring.done} of ${ring.of} on it (${ring.state}).`).join("")}`;
  return {
    text:
      companies.length > 0
        ? [...lines, goingOut].join("\n")
        : `The console runs no company yet. ${goingOut}`,
    structured: {
      platforms: companies.map(({ row, standing, needs }) => ({
        organization: row.id,
        status: row.status,
        standing,
        ring: row.ring,
        release: row.release,
        pinned: row.pinnedReleaseId,
        needs: needs.map((need) => need.kind),
      })),
      rollout:
        rollout === null
          ? null
          : {
              release: rollout.releaseId,
              status: rollout.status,
              ring: rollout.ring,
              rings,
            },
      names: {
        organizations: rows.map(({ id, name }) => ({ id, name })),
      },
    },
  };
};
