import type { ChatAgent } from "@grasp-os/shared/chat";
import { useLingui } from "@lingui/react/macro";
import { UsersRoundIcon } from "lucide-react";

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
    <span
      aria-label={t`${name} answers in this chat`}
      className="text-muted-foreground flex min-w-0 items-center gap-1.5 px-2 text-sm"
    >
      <UsersRoundIcon aria-hidden className="size-4 shrink-0" />
      <span aria-hidden className="max-w-40 min-w-0 truncate">
        {name}
      </span>
    </span>
  );
};
