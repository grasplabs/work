import { unmetNeeds } from "@grasp-os/shared/chat";
import type { ChatBuilt, ChatPlanned } from "@grasp-os/shared/chat";
import type { ModelEffort } from "@grasp-os/shared/models";
import { useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { markMade } from "../apps/made-tip.ts";
import { useCoreRead } from "../apps/use-core-read.ts";
import { setActiveChat } from "./active-chat.ts";
import { slotOf } from "./chat-subject.ts";
import { MakeActions } from "./make-card.tsx";
import { PlanCard } from "./plan-card.tsx";

// Making something new in a chat (any chat): the plan Grasp's agent
// proposes (plan-card.tsx), with Build it while it waits for the person,
// off while a connection it needs isn't there yet (read again whenever
// the window comes back, from connecting it on the integration's page).
// Build it makes what the plan lists and lands the person on it at once,
// the App first, with this chat docked beside it, where the agent goes on
// building it and the page says it is setting it up until it works
// (apps/app-workspace.tsx). That turn shows in the chat as any other.

/** What Build it asks with: the model and effort the box names, and the way to the box. */
export interface ThreadBuild {
  model: string | undefined;
  effort: ModelEffort | undefined;
  /** Takes the person to the box, to say what to change about the plan. */
  onChangePlan: () => void;
}

/** How many times the window came back to the page: when what was connected meanwhile is read again. */
const useReturns = (): number => {
  const [returns, setReturns] = useState(0);
  useEffect(() => {
    const back = (): void => {
      setReturns((before) => before + 1);
    };
    window.addEventListener("focus", back);
    return () => {
      window.removeEventListener("focus", back);
    };
  }, []);
  return returns;
};

/** Build it and Change the plan, Build it off while a connection is missing. */
const PlanActions = ({
  chatId,
  plan,
  build,
  ready,
}: {
  chatId: string;
  plan: ChatPlanned;
  build: ThreadBuild;
  ready: boolean;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const land = (built: ChatBuilt): void => {
    const { app, workflow } = built;
    if (app !== undefined) {
      setActiveChat(chatId, slotOf({ kind: "app", id: app.id }));
      markMade(app.id);
      void navigate({ to: "/apps/$app", params: { app: app.id } });
    } else if (workflow !== undefined) {
      setActiveChat(chatId, slotOf({ kind: "workflow", id: workflow.id }));
      void navigate({
        to: "/workflows/$workflow",
        params: { workflow: workflow.id },
      });
    }
  };
  return (
    <MakeActions
      build={build}
      changeLabel={t`Change the plan`}
      label={t`Build it`}
      onDone={land}
      press={async (session, asked) =>
        await session.chats.build(chatId, { plan: plan.callId, ...asked })
      }
      ready={ready}
    />
  );
};

/**
 * A plan in the thread: its card, and while it waits for the person
 * (`waiting`, and the thread can build: `build`), Build it, which waits
 * for every connection the plan needs.
 */
export const ThreadPlan = ({
  chatId,
  plan,
  waiting,
  build,
}: {
  chatId: string;
  plan: ChatPlanned;
  waiting: boolean;
  build: ThreadBuild | undefined;
}) => {
  const needs = plan.parts.some(({ needs: some = [] }) => some.length > 0);
  const returns = useReturns();
  const read = useCoreRead(
    `${plan.callId}/${returns}`,
    async (session) => (needs ? await session.connections.list() : []),
    plan.callId
  );
  const unmet =
    read?.state === "ready" ? unmetNeeds(plan, read.data) : undefined;
  return (
    <PlanCard
      actions={
        waiting && build !== undefined ? (
          <PlanActions
            build={build}
            chatId={chatId}
            plan={plan}
            ready={unmet?.length === 0}
          />
        ) : undefined
      }
      plan={plan}
      unmet={unmet ?? []}
    />
  );
};
