import type { AgentWakeInput } from "@grasp-os/shared/agents";
import type {
  CompanyToolClass,
  ToolClassAudience,
} from "@grasp-os/shared/connect";

import type { Session } from "../core.ts";
import { workOutQuietly } from "./agent-apps-card.tsx";
import type { AgentTab } from "./tabs.tsx";
import { keepUnsaved } from "./unsaved-instructions.ts";

// What a new agent's setup sets once the agent is made (manual-agent.tsx,
// new-agent.tsx), each part by calls of its own: its instructions first,
// as they are what the person typed, then its apps, what it may do, whom
// it answers and its schedule. No part waits on another: each one that
// fails is kept with why, and the rest are still set. The agent exists by
// then and its name is taken, so the setup never offers to make it again:
// its page opens and says, part by part, what was saved and what wasn't
// (`AgentSetupLeft`, agent-page.tsx), with Try again for what is left and
// the tab where each is set. Instructions that didn't save wait on its
// Instructions tab as the editor's draft (unsaved-instructions.ts), never
// dropped. In this tab's memory alone, by the agent's ID, until the page's
// alert is closed or nothing is left.

/** The parts a setup sets once the agent is made, in the order it sets them. */
export const setupParts = [
  "instructions",
  "apps",
  "abilities",
  "reach",
  "schedule",
] as const;
export type SetupPart = (typeof setupParts)[number];

/** The tab of an agent's page where each part is set. */
export const tabOfPart: Record<SetupPart, AgentTab> = {
  instructions: "instructions",
  apps: "instructions",
  abilities: "access",
  reach: "access",
  schedule: "schedule",
};

/** What a setup sets once the agent is made; an empty part sets nothing. */
export interface SetupPlan {
  /** Its instructions, as typed; "" for none. */
  instructions: string;
  /** Its apps, each as core names it (`agentAppOf`). */
  apps: readonly string[];
  /** The company's classes it may use, each as the company has it. */
  classes: readonly CompanyToolClass[];
  /** Whom it answers; undefined leaves it reaching nobody. */
  reach: Exclude<ToolClassAudience, { who: "nobody" }> | undefined;
  /** When it works on its own; undefined for only when asked. */
  wake: AgentWakeInput | undefined;
}

/** What a setup did of its plan: each part it set, each it couldn't with why, and what is left of it. */
export interface SetupOutcome {
  saved: readonly SetupPart[];
  unsaved: readonly { part: SetupPart; failure: string }[];
  /** The parts not saved, to try again; never the instructions, which wait on the page. */
  left: SetupPlan;
}

const nothing: SetupPlan = {
  instructions: "",
  apps: [],
  classes: [],
  reach: undefined,
  wake: undefined,
};

/**
 * Sets `plan` on the new agent `agentId`, part by part, each failure
 * caught on its own (`wordsOf` says why in the product's words), and
 * then works out the apps the saved instructions call for.
 */
export const finishSetup = async (
  session: Session,
  agentId: string,
  plan: SetupPlan,
  wordsOf: (error: unknown) => string
): Promise<SetupOutcome> => {
  const saved: SetupPart[] = [];
  const unsaved: { part: SetupPart; failure: string }[] = [];
  const left: SetupPlan = { ...nothing };
  /** Runs each of `items`' calls at once; the items whose call failed, and the first failure. */
  const each = async <T>(
    part: SetupPart,
    items: readonly T[],
    call: (item: T) => Promise<unknown>
  ): Promise<T[]> => {
    if (items.length === 0) {
      return [];
    }
    const settled = await Promise.allSettled(items.map(call));
    const failed = items.filter((_, at) => settled[at]?.status === "rejected");
    const rejected = settled.find(
      (one): one is PromiseRejectedResult => one.status === "rejected"
    );
    const reason: unknown = rejected?.reason;
    if (failed.length === 0) {
      saved.push(part);
    } else {
      unsaved.push({ part, failure: wordsOf(reason) });
    }
    return failed;
  };

  // What was typed comes first. Not saved, it waits on the page as its
  // editor's draft, with why.
  const { instructions } = plan;
  if (instructions.trim() !== "") {
    const change = crypto.randomUUID();
    await each("instructions", [instructions], async (text) => {
      try {
        await session.instructions.save({
          file: { scope: "agent", agentId },
          change,
          text,
          after: 0,
        });
      } catch (error) {
        keepUnsaved(agentId, { text, change, failure: wordsOf(error) });
        throw error;
      }
    });
  }
  left.apps = await each("apps", plan.apps, async (app) => {
    await session.connections.setAgentApp(agentId, app, true);
  });
  left.classes = await each("abilities", plan.classes, async (toolClass) => {
    await session.connections.setAgentToolClass(agentId, toolClass, {
      who: "asClass",
    });
  });
  const { reach, wake } = plan;
  if (reach !== undefined) {
    [left.reach] = await each("reach", [reach], async (audience) => {
      await session.connections.setAgentReach(agentId, true, audience);
    });
  }
  if (wake !== undefined) {
    [left.wake] = await each("schedule", [wake], async (input) => {
      await session.connections.makeAgentWake(agentId, input);
    });
  }
  // Last, once it has what it was given: the apps its instructions call for.
  if (saved.includes("instructions")) {
    await workOutQuietly(session, agentId);
  }
  return { saved, unsaved, left };
};

const kept = new Map<string, SetupOutcome>();

/** Keeps what the setup of the agent `agentId` couldn't save, for its page; nothing when it saved all. */
export const keepOutcome = (agentId: string, outcome: SetupOutcome): void => {
  if (outcome.unsaved.length === 0) {
    kept.delete(agentId);
  } else {
    kept.set(agentId, outcome);
  }
};

/** What the setup of the agent `agentId` couldn't save; undefined when it saved all. */
export const outcomeOf = (agentId: string): SetupOutcome | undefined =>
  kept.get(agentId);

/** Forgets it, once its page's alert is closed. */
export const forgetOutcome = (agentId: string): void => {
  kept.delete(agentId);
};
