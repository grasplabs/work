import type { Agent, AgentSettings, AgentWake } from "@grasp-os/shared/agents";
import type { ChatAgent } from "@grasp-os/shared/chat";
import type { StephenReach } from "@grasp-os/shared/stephen-reach";
import { buttonVariants } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import {
  BotIcon,
  CalendarClockIcon,
  MessageCircleIcon,
  PlusIcon,
  SearchIcon,
  UsersRoundIcon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { Page, PageHeading } from "../frame/page.tsx";
import { AgentAvatar } from "./agent-avatar.tsx";
import {
  AgentStateBadge,
  classesOn,
  useAudienceLine,
  wakesOn,
} from "./agent-facts.tsx";

// The Agents page: the company's agents as a grid of cards, as the Apps
// page has its Apps (apps/apps-overview.tsx). Everyone sees the agents
// they may talk to (`chats.agents`), each with the way into a chat with
// it. The company's admins see every agent (`connections.agents`), with
// whether it is on, whom it answers, how much it may do and whether it
// works on its own; a card opens the agent's page (agent-page.tsx), and
// New agent starts one (new-agent.tsx).

/** What an admin's read adds to the agents: every agent, and what core keeps of each. */
export interface ManagedAgents {
  /** Every agent, the company's first one first. */
  agents: readonly Agent[];
  /** Each agent's reach and classes but the first's, by its ID. */
  settings: Readonly<Record<string, AgentSettings>>;
  /** Each agent's wake-ups, by its ID. */
  wakes: Readonly<Record<string, readonly AgentWake[]>>;
  teams: StephenReach["teams"];
}

/** New agent: the page's one action. */
const NewAgentLink = () => (
  <Link className={buttonVariants()} to="/agents/new">
    <PlusIcon data-icon="inline-start" />
    <Trans>New agent</Trans>
  </Link>
);

/** One fact of an agent on its card: an icon and a few words. */
const Fact = ({ icon, children }: { icon: ReactNode; children: ReactNode }) => (
  <span className="flex min-w-0 items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:flex-none">
    {icon}
    <span className="truncate">{children}</span>
  </span>
);

/** Into a new chat with an agent; above the card's own link. */
const ChatLink = ({ agentId, name }: { agentId: string; name: string }) => {
  const { t } = useLingui();
  return (
    <Link
      aria-label={t`Chat with ${name}`}
      className={buttonVariants({
        size: "sm",
        variant: "outline",
        className: "relative z-10",
      })}
      search={{ agent: agentId }}
      to="/"
    >
      <MessageCircleIcon data-icon="inline-start" />
      <Trans>Chat</Trans>
    </Link>
  );
};

/** What a card shows of one agent. */
interface Shown {
  id: string;
  name: string;
  job: string;
  /** The figure it is drawn with, by name. */
  face: string;
  /** Whether the person may talk to it. */
  usable: boolean;
  /** As an admin reads it; undefined for anyone else. */
  managed:
    | {
        state: Agent["state"];
        first: boolean;
        settings: AgentSettings | undefined;
        wakes: readonly AgentWake[];
      }
    | undefined;
}

/** What an admin's card says of an agent under its job. */
const ManagedFacts = ({
  managed,
  teams,
}: {
  managed: NonNullable<Shown["managed"]>;
  teams: StephenReach["teams"];
}) => {
  const audienceLine = useAudienceLine(teams);
  const { settings, first } = managed;
  const scheduled = wakesOn(managed.wakes).length;
  const classes = settings === undefined ? undefined : classesOn(settings);
  return (
    <div className="text-muted-foreground flex flex-col gap-1.5 text-xs">
      <Fact icon={<UsersRoundIcon />}>
        {first || settings === undefined ? (
          <Trans>Set in Settings › Stephen</Trans>
        ) : (
          audienceLine(settings.audience)
        )}
      </Fact>
      {classes === undefined ? null : (
        <Fact icon={<WrenchIcon />}>
          {classes.on === 0 ? (
            <Trans>May do nothing yet</Trans>
          ) : (
            <Trans>
              {classes.on} of {classes.of} kinds of work
            </Trans>
          )}
        </Fact>
      )}
      <Fact icon={<CalendarClockIcon />}>
        {scheduled === 0 ? (
          <Trans>Only when asked</Trans>
        ) : (
          <Plural
            one="Works on its own, # schedule"
            other="Works on its own, # schedules"
            value={scheduled}
          />
        )}
      </Fact>
    </div>
  );
};

/** One agent: its card. An admin's opens its page; anyone else's, a chat with it. */
const AgentCard = ({
  shown,
  teams,
}: {
  shown: Shown;
  teams: StephenReach["teams"];
}) => {
  const { managed } = shown;
  const nameClass =
    "truncate font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:underline";
  const answers = managed === undefined || managed.state === "on";
  return (
    <li className="bg-card hover:border-ring/40 relative flex min-w-0 flex-col gap-4 rounded-xl border p-4 transition-colors">
      <div className="flex items-start gap-3">
        <AgentAvatar face={shown.face} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {managed === undefined ? (
            <Link className={nameClass} search={{ agent: shown.id }} to="/">
              {shown.name}
            </Link>
          ) : (
            <Link
              className={nameClass}
              params={{ agent: shown.id }}
              to="/agents/$agent"
            >
              {shown.name}
            </Link>
          )}
          <p className="text-muted-foreground line-clamp-2 text-sm">
            {shown.job === "" ? <Trans>No job written yet</Trans> : shown.job}
          </p>
        </div>
      </div>
      {managed === undefined ? null : (
        <ManagedFacts managed={managed} teams={teams} />
      )}
      <div className="mt-auto flex min-h-8 items-center justify-between gap-2">
        {managed === undefined ? (
          <span />
        ) : (
          <AgentStateBadge state={managed.state} />
        )}
        {shown.usable && answers ? (
          <ChatLink agentId={shown.id} name={shown.name} />
        ) : null}
      </div>
    </li>
  );
};

/** Which agents an admin's list shows. */
const filters = ["all", "on", "paused"] as const;
type Filter = (typeof filters)[number];

/** The cards: every agent for an admin, else the ones the person may talk to. */
const shownOf = (
  usable: readonly ChatAgent[],
  managed: ManagedAgents | undefined
): Shown[] => {
  if (managed === undefined) {
    return usable.map(({ id, name, job, face }) => ({
      id,
      name,
      job,
      face,
      usable: true,
      managed: undefined,
    }));
  }
  const [first] = managed.agents;
  return managed.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    job: agent.job,
    face: agent.face,
    usable: usable.some(({ id }) => id === agent.id),
    managed: {
      state: agent.state,
      first: agent.id === first?.id,
      settings: managed.settings[agent.id],
      wakes: managed.wakes[agent.id] ?? [],
    },
  }));
};

/** The Agents page's body: the agents the person may `usable`, and what an admin `managed`. */
export const AgentsOverview = ({
  usable,
  managed,
}: {
  usable: readonly ChatAgent[];
  managed: ManagedAgents | undefined;
}) => {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const agents = shownOf(usable, managed);
  const asked = query.trim();
  const needle = asked.toLocaleLowerCase();
  const shown = agents.filter(
    (agent) =>
      (needle === "" ||
        agent.name.toLocaleLowerCase().includes(needle) ||
        agent.job.toLocaleLowerCase().includes(needle)) &&
      (filter === "all" || agent.managed?.state === filter)
  );
  const paused = agents.filter(
    (agent) => agent.managed?.state === "paused"
  ).length;
  return (
    <Page wide>
      <PageHeading
        action={managed === undefined ? undefined : <NewAgentLink />}
        description={
          managed === undefined ? (
            <Trans>
              The agents you can ask. Each has its own job and knows its own
              part of the company.
            </Trans>
          ) : (
            <Trans>
              Each agent has its own name and job, answers only the people you
              choose, and does only what you let it.
            </Trans>
          )
        }
        title={<Trans>Agents</Trans>}
      />
      {agents.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BotIcon />
            </EmptyMedia>
            <EmptyTitle>
              <Trans>No agents yet</Trans>
            </EmptyTitle>
            <EmptyDescription>
              {managed === undefined ? (
                <Trans>
                  The agents your company sets up for you show here.
                </Trans>
              ) : (
                <Trans>
                  Make one for a job, such as chasing unpaid invoices, and say
                  who may ask it.
                </Trans>
              )}
            </EmptyDescription>
          </EmptyHeader>
          {managed === undefined ? null : (
            <EmptyContent>
              <NewAgentLink />
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="w-full sm:w-72">
              <InputGroup>
                <InputGroupInput
                  aria-label={t`Search the agents`}
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                  placeholder={t`Search`}
                  value={query}
                />
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
              </InputGroup>
            </div>
            {/* Only where some are paused: with all on there is nothing to tell apart. */}
            {managed === undefined || paused === 0 ? null : (
              <ToggleGroup
                aria-label={t`Which agents to show`}
                onValueChange={(next: unknown[]) => {
                  const picked = filters.find((each) => each === next.at(0));
                  setFilter(picked ?? "all");
                }}
                size="sm"
                value={[filter]}
                variant="outline"
              >
                <ToggleGroupItem value="all">
                  <Trans>All</Trans>
                </ToggleGroupItem>
                <ToggleGroupItem value="on">
                  <Trans>On</Trans>
                </ToggleGroupItem>
                <ToggleGroupItem value="paused">
                  <Trans>Paused</Trans>
                </ToggleGroupItem>
              </ToggleGroup>
            )}
          </div>
          {shown.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {asked === "" ? (
                    <Trans>No agent to show here</Trans>
                  ) : (
                    <Trans>No agent matches “{asked}”</Trans>
                  )}
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul
              aria-label={t`Agents`}
              className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
            >
              {shown.map((agent) => (
                <AgentCard
                  key={agent.id}
                  shown={agent}
                  teams={managed?.teams ?? []}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </Page>
  );
};
