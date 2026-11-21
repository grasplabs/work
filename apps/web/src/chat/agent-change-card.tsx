import type { Agent, AgentChangeDrafted } from "@grasp-os/shared/agents";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { useCoreRead } from "../apps/use-core-read.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { classNames } from "../settings/stephen-settings.tsx";
import {
  AppNames,
  AudienceWords,
  DraftActions,
  lines,
  ScheduleWords,
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

const styles = stylex.create({
  beforeAfter: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
  },
  before: {
    color: grasp.muted,
    textDecorationLine: "line-through",
    textDecorationThickness: "1px",
  },
  // All of it, as it will be kept: long ones scroll.
  long: {
    display: "block",
    maxHeight: "16rem",
    overflowY: "auto",
    whiteSpace: "pre-wrap",
  },
  longBefore: {
    maxHeight: "8rem",
  },
});

/** What a part is now, and what it becomes. */
const BeforeAfter = ({
  now,
  becomes,
}: {
  now: string | undefined;
  becomes: ReactNode;
}) => (
  <span {...stylex.props(styles.beforeAfter)}>
    {now === undefined ? null : (
      <span {...stylex.props(styles.before, styles.long, styles.longBefore)}>
        {now}
      </span>
    )}
    <span {...stylex.props(styles.long)}>{becomes}</span>
  </span>
);

/** The drafted change as a card, with `actions` while it waits. */
const AgentChangeCard = ({
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
      <KeyValueList
        items={lines([
          job === undefined
            ? undefined
            : {
                key: t`What it is for`,
                value: <BeforeAfter becomes={job} now={now?.job} />,
              },
          addInstructions === undefined
            ? undefined
            : {
                key: t`Added to its instructions`,
                value: (
                  <span {...stylex.props(styles.long)}>{addInstructions}</span>
                ),
              },
          addApps.length === 0
            ? undefined
            : { key: t`Apps it gets`, value: <AppNames apps={addApps} /> },
          removeApps.length === 0
            ? undefined
            : {
                key: t`Apps taken off`,
                value: <AppNames apps={removeApps} />,
              },
          audience === undefined
            ? undefined
            : {
                key: t`Who may ask it`,
                value: <AudienceWords audience={audience} />,
              },
          turnOn.length === 0
            ? undefined
            : {
                key: t`What it may also do`,
                value: turnOn
                  .map((each) => i18n._(classNames[each]))
                  .join(", "),
              },
          schedule === undefined
            ? undefined
            : {
                key: t`Also works on its own`,
                value: <ScheduleWords schedule={schedule} />,
              },
        ])}
      />
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
