import type { ChatAgent } from "@grasp-os/shared/chat";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { AgentMark } from "../grasp/agent-mark/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// Which of the company's agents answers, in the box to ask in. A person
// with one agent sees nothing here, as before there were more. With more,
// an open chat's box names the one that answered last (`AgentName`), which
// a question that mentions none goes to. A person picks an agent by
// mentioning it (`@`, mentions.tsx), in a new chat or an open one. The
// agents are the ones core lists for this person (`chats.agents()`); one
// that isn't theirs any more has no name here.

const styles = stylex.create({
  name: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    maxWidth: "12rem",
    paddingInline: grasp.space2,
  },
});

/** The model the agent `agentId` answers with, where an admin gave it one. */
export const agentModelOf = (
  agents: readonly ChatAgent[],
  agentId: string | undefined
): string | undefined =>
  agents.find(({ id }) => id === agentId)?.model ?? undefined;

/** The agent an open chat is with, where the person has more than one. */
export const AgentName = ({
  agents,
  agentId,
}: {
  agents: readonly ChatAgent[];
  agentId: string;
}) => {
  const { t } = useLingui();
  const agent = agents.find(({ id }) => id === agentId);
  if (agents.length < 2 || agent === undefined) {
    return null;
  }
  const { name } = agent;
  return (
    <span
      aria-label={t`${name} answers in this chat`}
      {...stylex.props(styles.name)}
    >
      <AgentMark name={name} size="xs" />
      <span aria-hidden>
        <Text element="span" size="sm" tone="muted" wrap="truncate">
          {name}
        </Text>
      </span>
    </span>
  );
};
