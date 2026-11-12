import { unmetNeeds } from "@grasp-os/shared/chat";
import type {
  ChatBuilt,
  ChatMessage,
  ChatPlanned,
} from "@grasp-os/shared/chat";
import type { ModelEffort } from "@grasp-os/shared/models";
import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { markMade } from "../apps/made-tip.ts";
import { useCoreRead } from "../apps/use-core-read.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { setActiveChat } from "./active-chat.ts";
import { slotOf } from "./chat-subject.ts";
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

/** The plan waiting for the person: the latest reply's, while nothing runs and nothing was said since. */
export const pendingPlan = (
  messages: readonly ChatMessage[],
  running: boolean
): ChatPlanned | undefined => {
  if (running) {
    return undefined;
  }
  const last = messages.findLast(({ role }) => role !== "result");
  return last?.role === "assistant" ? last.planned : undefined;
};

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
  const { busy, failure, run } = useCoreAction();
  const { model, effort } = build;
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
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!ready || busy || model === undefined}
          onClick={() => {
            if (model === undefined) {
              return;
            }
            void (async () => {
              const built = await run(
                async (session) =>
                  await session.chats.build(chatId, {
                    plan: plan.callId,
                    text: t`Build it`,
                    model,
                    ...(effort === undefined ? {} : { effort }),
                  })
              );
              if (built !== undefined) {
                land(built);
              }
            })();
          }}
          variant="highlight"
        >
          <Trans>Build it</Trans>
        </Button>
        <Button
          onClick={() => {
            build.onChangePlan();
          }}
          variant="outline"
        >
          <Trans>Change the plan</Trans>
        </Button>
      </div>
      <ErrorText>{failure}</ErrorText>
    </div>
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
