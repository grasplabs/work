// Teams' adapter sends through axios, which needs the fix in first (door.ts).
import "@grasp-os/chat/workerd";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { chatWorkflowOffers } from "../db/core/schema.ts";
import { teamsAdapter } from "./teams.ts";
import { channelLocales, say } from "./words.ts";
import type { ChannelLocale } from "./words.ts";

// A run a press on one of Stephen's cards started (workflow-offers.ts),
// told where it was pressed once it ends, and how: kept apart from the
// offers, as what ends a run (workflows/resource-runs.ts) can't import
// what starts one.

/** The line for how a run ended; none while it hasn't. */
const endLine = (
  status: string
): "runCompleted" | "runFailed" | "runStopped" | undefined => {
  switch (status) {
    case "completed": {
      return "runCompleted";
    }
    case "failed": {
      return "runFailed";
    }
    case "cancelled": {
      return "runStopped";
    }
    default: {
      return undefined;
    }
  }
};

const localeOf = (locale: string | null): ChannelLocale =>
  channelLocales.find((each) => each === locale) ?? "en";

/**
 * Tells where its offer was pressed that run `run` ended, and how, once:
 * for a run a press on one of Stephen's cards started. Best effort, after
 * the end is written: a line that can't be sent is logged, never retried,
 * and never fails what ended the run.
 */
export const tellOfferedRunEnd = async (
  env: Env,
  run: { id: string; status: string }
): Promise<void> => {
  const line = endLine(run.status);
  if (line === undefined) {
    return;
  }
  try {
    const told = await drizzle(env.DB)
      .update(chatWorkflowOffers)
      .set({ toldAt: new Date() })
      .where(
        and(
          eq(chatWorkflowOffers.runId, run.id),
          isNull(chatWorkflowOffers.toldAt),
          isNotNull(chatWorkflowOffers.threadId),
          eq(chatWorkflowOffers.platform, "teams")
        )
      )
      .returning();
    const adapter = told.length === 0 ? undefined : await teamsAdapter(env);
    for (const offer of told) {
      if (adapter === undefined || offer.threadId === null) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- at most one per run
      await adapter.postMessage(
        offer.threadId,
        say(line, localeOf(offer.locale), { workflow: offer.workflowName })
      );
    }
  } catch (error) {
    log.warn("channel.run_end_untold", {
      runId: run.id,
      ...errorFields(error),
    });
  }
};
