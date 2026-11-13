import type {
  Agent,
  AgentSettings,
  AgentUsage,
  AgentWake,
} from "@grasp-os/shared/agents";
import type { ChatAgent } from "@grasp-os/shared/chat";
import type { Member } from "@grasp-os/shared/members";
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
  CoinsIcon,
  MessageCircleIcon,
  PlusIcon,
  SearchIcon,
  UsersRoundIcon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { Page, PageHeading } from "../frame/page.tsx";
import { dollars } from "../settings/money.ts";
import { AgentAvatar } from "./agent-avatar.tsx";
import {
  AgentStateBadge,
  classesOn,
  useAudienceLine,
  wakesOn,
} from "./agent-facts.tsx";
import { OfferedAgents } from "./agent-share.tsx";
import { OwnAgentsCard } from "./own-agents-admin.tsx";
import type { OwnAgentsAdmin } from "./own-agents-admin.tsx";

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
  /** What each agent used of the models this month, by its ID; none where core didn't say. */
  usage: Readonly<Record<string, AgentUsage>>;
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
  /** Whether it answers, for one of the person's own; undefined for any other. */
  own?: Agent["state"];
  /** As an admin reads it; undefined for anyone else. */
  managed:
    | {
        state: Agent["state"];
        first: boolean;
        settings: AgentSettings | undefined;
        wakes: readonly AgentWake[];
        usage: AgentUsage | undefined;
      }
    | undefined;
}

/**
 * Whom an agent answers, on its card: the first agent everyone with
 * Grasp; another its own audience (`line`), or that it isn't shown where
 * core didn't say, never passed off as everyone.
 */
const AudienceFact = ({
  first,
  line,
}: {
  first: boolean;
  line: string | undefined;
}) => {
  if (first) {
    return <Trans>Everyone with Grasp</Trans>;
  }
  return line ?? <Trans>Access not shown</Trans>;
};

/** What an admin's card says of an agent under its job. */
const ManagedFacts = ({
  managed,
  teams,
}: {
  managed: NonNullable<Shown["managed"]>;
  teams: StephenReach["teams"];
}) => {
  const audienceLine = useAudienceLine(teams);
  const { settings, first, usage } = managed;
  const spent = usage === undefined ? undefined : dollars(usage.spent);
  const scheduled = wakesOn(managed.wakes).length;
  const classes = settings === undefined ? undefined : classesOn(settings);
  return (
    <div className="text-muted-foreground flex flex-col gap-1.5 text-xs">
      <Fact icon={<UsersRoundIcon />}>
        <AudienceFact
          first={first}
          line={
            settings === undefined ? undefined : audienceLine(settings.audience)
          }
        />
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
      {/* Only once it was asked this month: a new agent has cost nothing to say. */}
      {usage === undefined || usage.requests === 0 ? null : (
        <Fact icon={<CoinsIcon />}>
          <Trans>{spent} this month</Trans>
        </Fact>
      )}
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
  const { managed, own } = shown;
  const nameClass =
    "truncate font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:underline";
  const state = managed?.state ?? own;
  const answers = state === undefined || state === "on";
  return (
    <li className="bg-card hover:border-ring/40 relative flex min-w-0 flex-col gap-4 rounded-xl border p-4 transition-colors">
      <div className="flex items-start gap-3">
        <AgentAvatar face={shown.face} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {state === undefined ? (
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
      {own === undefined ? null : (
        <div className="text-muted-foreground flex flex-col gap-1.5 text-sm">
          <Fact icon={<UsersRoundIcon />}>
            <Trans>Only you</Trans>
          </Fact>
        </div>
      )}
      <div className="mt-auto flex min-h-8 items-center justify-between gap-2">
        {state === undefined ? <span /> : <AgentStateBadge state={state} />}
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

/**
 * The cards of the person's own agents, each opening its page, with a way
 * into a chat only for one core lists them as asking (`usable`): none
 * while the company has them off.
 */
const ownShownOf = (
  own: readonly Agent[],
  usable: readonly ChatAgent[]
): Shown[] =>
  own.map(({ id, name, job, face, state }) => ({
    id,
    name,
    job,
    face,
    usable: usable.some((each) => each.id === id),
    own: state,
    managed: undefined,
  }));

/**
 * The cards of the company's agents: every one for an admin, else the
 * ones the person may talk to. Never one of the person's own, which have
 * their own cards.
 */
const shownOf = (
  all: readonly ChatAgent[],
  managed: ManagedAgents | undefined
): Shown[] => {
  const usable = all.filter(({ own }) => !own);
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
      usage: managed.usage[agent.id],
    },
  }));
};

/** A group of agents' cards. */
const Cards = ({
  agents,
  teams,
  label,
}: {
  agents: readonly Shown[];
  teams: StephenReach["teams"];
  label: string;
}) => (
  <ul
    aria-label={label}
    className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
  >
    {agents.map((agent) => (
      <AgentCard key={agent.id} shown={agent} teams={teams} />
    ))}
  </ul>
);

/**
 * The Agents page's body: the person's `own` agents, the company's they
 * may `usable`, and what an admin `managed`.
 */
export const AgentsOverview = ({
  usable,
  managed,
  own,
  makes,
  makesOwn,
  offered,
  ownAdmin,
}: {
  usable: readonly ChatAgent[];
  managed: ManagedAgents | undefined;
  /** The person's own agents, which nobody else sees. */
  own: readonly Agent[];
  /** Whether the person may make an agent for the company: its own admins. */
  makes: boolean;
  /** Whether the person may make one of their own: anyone of the company, while the company lets them. */
  makesOwn: boolean;
  /** For admins: the agents people offered the company, and who they are. */
  offered?: { agents: readonly Agent[]; people: readonly Member[] } | undefined;
  /** What an admin reads of people's own agents; undefined for anyone else. */
  ownAdmin?: OwnAgentsAdmin | undefined;
}) => {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const agents = shownOf(usable, managed);
  const asked = query.trim();
  const needle = asked.toLocaleLowerCase();
  const matches = (agent: Shown): boolean =>
    needle === "" ||
    agent.name.toLocaleLowerCase().includes(needle) ||
    agent.job.toLocaleLowerCase().includes(needle);
  const shown = agents.filter(
    (agent) =>
      matches(agent) && (filter === "all" || agent.managed?.state === filter)
  );
  const mine = ownShownOf(own, usable).filter(
    (agent) => matches(agent) && (filter === "all" || agent.own === filter)
  );
  const paused = agents.filter(
    (agent) => agent.managed?.state === "paused"
  ).length;
  const canMake = makes || makesOwn;
  return (
    <Page wide>
      <PageHeading
        action={canMake ? <NewAgentLink /> : undefined}
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
      {agents.length === 0 && own.length === 0 ? (
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
                  The agents your company sets up for you show here. You can
                  also make one of your own.
                </Trans>
              ) : (
                <Trans>
                  Make one for a job, such as chasing unpaid invoices, and say
                  who may ask it.
                </Trans>
              )}
            </EmptyDescription>
          </EmptyHeader>
          {canMake ? (
            <EmptyContent>
              <NewAgentLink />
            </EmptyContent>
          ) : null}
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
          {shown.length === 0 && mine.length === 0 ? (
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
          ) : null}
          {/* The person's own first, told apart from the company's only
              where they have some. */}
          {mine.length === 0 ? null : (
            <section className="flex flex-col gap-3">
              <div className="flex flex-col gap-0.5">
                <h2 className="font-medium">
                  <Trans>Yours</Trans>
                </h2>
                <p className="text-muted-foreground text-sm">
                  <Trans>Only you see and ask these.</Trans>
                </p>
              </div>
              <Cards agents={mine} label={t`Your agents`} teams={[]} />
            </section>
          )}
          {shown.length === 0 ? null : (
            <section className="flex flex-col gap-3">
              {own.length === 0 ? null : (
                <h2 className="font-medium">
                  <Trans>Your company&apos;s</Trans>
                </h2>
              )}
              <Cards
                agents={shown}
                label={t`Agents`}
                teams={managed?.teams ?? []}
              />
            </section>
          )}
        </>
      )}
      {offered === undefined ? null : (
        <OfferedAgents
          editable={makes}
          offered={offered.agents}
          people={offered.people}
        />
      )}
      {ownAdmin === undefined ? null : (
        <OwnAgentsCard admin={ownAdmin} editable={makes} />
      )}
    </Page>
  );
};
