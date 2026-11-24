import type { Agent, AgentChangeDrafted } from "@grasp-os/shared/agents";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { useCoreRead } from "../apps/use-core-read.ts";
import { classNames } from "../settings/stephen-settings.tsx";
import {
  AppNames,
  AudienceWords,
  DraftActions,
  linesOf,
  Long,
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
  beforeAfter: { display: "grid", gap: space["1"] },
  // What it was, struck through, over what it becomes.
  was: { textDecorationLine: "line-through", textDecorationThickness: 1 },
});

/** What a part is now, struck through, over what it becomes. */
const BeforeAfter = ({
  now,
  becomes,
}: {
  now: string | undefined;
  becomes: ReactNode;
}) => (
  <span {...stylex.props(styles.beforeAfter)}>
    {now === undefined ? null : (
      <span {...stylex.props(styles.was)}>
        <Text as="span" color="muted">
          <Long short>{now}</Long>
        </Text>
      </span>
    )}
    <Long>{becomes}</Long>
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
      <KeyValueList
        items={linesOf([
          job !== undefined && {
            id: "job",
            label: t`What it is for`,
            value: <BeforeAfter becomes={job} now={now?.job} />,
          },
          addInstructions !== undefined && {
            id: "instructions",
            label: t`Added to its instructions`,
            value: <Long>{addInstructions}</Long>,
          },
          addApps.length > 0 && {
            id: "add-apps",
            label: t`Apps it gets`,
            value: <AppNames apps={addApps} />,
          },
          removeApps.length > 0 && {
            id: "remove-apps",
            label: t`Apps taken off`,
            value: <AppNames apps={removeApps} />,
          },
          audience !== undefined && {
            id: "audience",
            label: t`Who may ask it`,
            value: <AudienceWords audience={audience} />,
          },
          turnOn.length > 0 && {
            id: "turn-on",
            label: t`What it may also do`,
            value: turnOn.map((each) => i18n._(classNames[each])).join(", "),
          },
          schedule !== undefined && {
            id: "schedule",
            label: t`Also works on its own`,
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
