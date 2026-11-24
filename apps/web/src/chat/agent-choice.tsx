import type { ChatAgent } from "@grasp-os/shared/chat";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, UserSparklesIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  agent: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
    minWidth: 0,
  },
});

// Which of the company's agents answers, in the box to ask in. A person
// with one agent sees nothing here, as before there were more. With more,
// an open chat's box names the one that answered last (`AgentName`), which
// a question that mentions none goes to. A person picks an agent by
// mentioning it (`@`, mentions.tsx), in a new chat or an open one. The agents are the ones core lists for this person
// (`chats.agents()`); one that isn't theirs any more has no name here.

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
    <span {...stylex.props(styles.agent)}>
      <Icon icon={UserSparklesIcon} label={t`${name} answers in this chat`} />
      <span aria-hidden="true">
        <Text as="span" color="muted" size="sm" truncate>
          {name}
        </Text>
      </span>
    </span>
  );
};
