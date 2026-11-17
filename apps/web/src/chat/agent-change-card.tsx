import type { Agent, AgentChangeDrafted } from "@grasp-os/shared/agents";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { useCoreRead } from "../apps/use-core-read.ts";
import { classNames } from "../settings/stephen-settings.tsx";
import {
  AppNames,
  AudienceWords,
  DraftActions,
  Line,
} from "./agent-draft-card.tsx";
import type { ThreadBuild } from "./build-progress.tsx";
import { MakeCard } from "./make-card.tsx";

// A change to one of the person's agents that Grasp's chat drafted
// (`draftAgentChange`), in the thread: what the agent is now and what it
// becomes, only what changes, and nothing changed until they press
// Change it, which changes it as the card shows it, by the agent page's
// own checks (`ChatsApi.changeDraftedAgent`), then lands the person on its
// page. What the model wrote is shown as text.

/** The agent a change names, as it is now: among the person's own, or the company's for an admin. */
const useAgentNow = (change: AgentChangeDrafted): Agent | undefined => {
  const read = useCoreRead(
    change.callId,
    async (session) =>
      change.whose === "own"
        ? await session.connections.ownAgents()
        : await session.connections.agents(),
    change.callId
  );
  const key = change.agent.trim().toLowerCase();
  return read?.state === "ready"
    ? read.data.find(({ name }) => name.toLowerCase() === key)
    : undefined;
};

/** What a part is now, and what it becomes. */
const BeforeAfter = ({
  now,
  becomes,
}: {
  now: string | undefined;
  becomes: ReactNode;
}) => (
  <span className="flex flex-col gap-1">
    {now === undefined ? null : (
      <span className="text-muted-foreground line-through decoration-1">
        <span className="block max-h-32 overflow-y-auto whitespace-pre-wrap">
          {now}
        </span>
      </span>
    )}
    <span className="block max-h-64 overflow-y-auto whitespace-pre-wrap">
      {becomes}
    </span>
  </span>
);

/** The drafted change as a card, with `actions` while it waits. */
export const AgentChangeCard = ({
  change,
  actions,
}: {
  change: AgentChangeDrafted;
  actions?: ReactNode;
}) => {
  const { t, i18n } = useLingui();
  const now = useAgentNow(change);
  const {
    agent: name,
    job,
    addInstructions,
    addApps = [],
    removeApps = [],
    audience,
    turnOn = [],
    schedule,
  } = change;
  return (
    <MakeCard
      actions={actions}
      description={
        <Trans>
          Nothing changes until you say Change it. You can change any of it
          first.
        </Trans>
      }
      label={t`A change to ${name}`}
      title={t`Change ${name}`}
    >
      <dl className="flex flex-col gap-3">
        {job === undefined ? null : (
          <Line label={t`What it is for`}>
            <BeforeAfter becomes={job} now={now?.job} />
          </Line>
        )}
        {addInstructions === undefined ? null : (
          <Line label={t`Added to its instructions`}>
            <span className="block max-h-64 overflow-y-auto whitespace-pre-wrap">
              {addInstructions}
            </span>
          </Line>
        )}
        {addApps.length === 0 ? null : (
          <Line label={t`Apps it gets`}>
            <AppNames apps={addApps} />
          </Line>
        )}
        {removeApps.length === 0 ? null : (
          <Line label={t`Apps taken off`}>
            <AppNames apps={removeApps} />
          </Line>
        )}
        {audience === undefined ? null : (
          <Line label={t`Who may ask it`}>
            <AudienceWords audience={audience} />
          </Line>
        )}
        {turnOn.length === 0 ? null : (
          <Line label={t`What it may also do`}>
            {turnOn.map((each) => i18n._(classNames[each])).join(", ")}
          </Line>
        )}
        {schedule === undefined ? null : (
          <Line label={t`Also works on its own`}>
            <span className="font-mono text-xs">{schedule.cron}</span>
            {" · "}
            {schedule.timeZone ?? t`the company's time zone`}
            {" · "}
            {schedule.opening}
          </Line>
        )}
      </dl>
    </MakeCard>
  );
};

/**
 * A drafted change in the thread: its card, and while it waits for the
 * person (`waiting`, and the thread can ask: `build`), Change it.
 */
export const ThreadAgentChange = ({
  chatId,
  change,
  waiting,
  build,
}: {
  chatId: string;
  change: AgentChangeDrafted;
  waiting: boolean;
  build: ThreadBuild | undefined;
}) => (
  <AgentChangeCard
    actions={
      waiting && build !== undefined ? (
        <DraftActions
          build={build}
          callId={change.callId}
          chatId={chatId}
          press="change"
        />
      ) : undefined
    }
    change={change}
  />
);
