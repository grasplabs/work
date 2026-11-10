import type { ChatAgent } from "@grasp-os/shared/chat";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { PromptInputButton } from "@grasp-os/ui/components/prompt-input";
import { useLingui } from "@lingui/react/macro";
import { ChevronDownIcon, UsersRoundIcon } from "lucide-react";

// Which of the company's agents answers, in the box to ask in. A person
// with one agent sees nothing here, as before there were more. With more,
// a new chat's box picks one (`AgentPicker`), and an open chat's box names
// the one it is with (`AgentName`): a chat stays with its agent, so there
// it is no control. The agents are the ones core lists for this person
// (`chats.agents()`); one that isn't theirs any more has no name here.

/** The agent a new chat starts with: the one picked, while it is still theirs, else the first. */
export const startingAgent = (
  agents: readonly ChatAgent[],
  picked?: string
): ChatAgent | undefined =>
  agents.find(({ id }) => id === picked) ?? agents.at(0);

/** Which agent answers a new chat, where the person has more than one. */
export const AgentPicker = ({
  agents,
  agentId,
  onAgent,
}: {
  agents: readonly ChatAgent[];
  agentId: string | undefined;
  onAgent: (agentId: string) => void;
}) => {
  const { t } = useLingui();
  const agent = startingAgent(agents, agentId);
  if (agents.length < 2 || agent === undefined) {
    return null;
  }
  const { name } = agent;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t`${name} answers. Change agent`}
        render={<PromptInputButton size="sm" />}
      >
        <UsersRoundIcon className="text-muted-foreground" />
        <span className="max-w-40 truncate">{name}</span>
        <ChevronDownIcon className="text-muted-foreground size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t`Who answers`}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(value: unknown) => {
              if (typeof value === "string") {
                onAgent(value);
              }
            }}
            value={agent.id}
          >
            {agents.map((each) => (
              <DropdownMenuRadioItem key={each.id} value={each.id}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{each.name}</span>
                  {each.job === "" ? null : (
                    <span className="text-muted-foreground line-clamp-2 text-xs">
                      {each.job}
                    </span>
                  )}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

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
      className="text-muted-foreground flex items-center gap-1.5 px-2 text-sm"
    >
      <UsersRoundIcon aria-hidden className="size-4" />
      <span aria-hidden className="max-w-40 truncate">
        {name}
      </span>
    </span>
  );
};
