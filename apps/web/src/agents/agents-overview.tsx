import type {
  Agent,
  AgentSettings,
  AgentUsage,
  AgentWake,
} from "@grasp-os/shared/agents";
import type { ChatAgent } from "@grasp-os/shared/chat";
import type { StephenReach } from "@grasp-os/shared/stephen-reach";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Page, PageHeading } from "../frame/page.tsx";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Card,
  CardDescription,
  CardLink,
  CardMedia,
  CardTitle,
} from "../grasp/card/index.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { AgentPerson, Plus } from "../grasp/icons/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { dollars } from "../settings/money.ts";
import { classesOn, useAudienceLine, wakesOn } from "./agent-facts.tsx";
import { AgentAura, AgentFigure } from "./figure/agent-figure.tsx";
import type { FigureState } from "./figure/body.ts";
import { lookOf } from "./figure/look.ts";

// The Agents page: the company's agents, a card each, on Damsko's linked Card. Each card's picture
// is the agent itself: its figure (Damsko's Stephen in the shape and palette it was given,
// figure/) standing on its own night, an aura dithered in its palette; asleep while it is paused,
// and turning to the pointer that rests on it. Everyone sees the agents they may talk to
// (`chats.agents`), and their card opens a chat with it. The company's admins see every agent
// (`connections.agents`) with whom it answers, how much it may do, whether it works on its own and
// what it cost this month, and its card opens its page. New agent opens the page where Grasp asks
// what the agent is for (new-agent.tsx).

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

const styles = stylex.create({
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 16rem), 1fr))",
    gap: grasp.space4,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // The card's picture: the aura fills it, the figure stands in its middle.
  stage: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    aspectRatio: "4 / 3",
    isolation: "isolate",
  },
  words: { display: "grid", gap: grasp.space1, marginBlockStart: grasp.space3 },
  title: { display: "flex", alignItems: "center", gap: grasp.space2 },
});

/** What a card shows of one agent. */
interface Shown {
  id: string;
  name: string;
  job: string;
  /** The look it was given, as core keeps it. */
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
        usage: AgentUsage | undefined;
      }
    | undefined;
}

/**
 * What an admin's card says of an agent under its job, a few words each:
 * whom it answers (the first agent everyone with Grasp; another its own
 * audience, or that it isn't shown where core didn't say, never passed
 * off as everyone), how much it may do, whether it works on its own and,
 * once it was asked this month, what that cost.
 */
const useFacts = (teams: StephenReach["teams"]) => {
  const { t } = useLingui();
  const audienceLine = useAudienceLine(teams);
  return (managed: NonNullable<Shown["managed"]>): string[] => {
    const { settings, first, usage } = managed;
    const facts: string[] = [];
    if (first) {
      facts.push(t`Everyone with Grasp`);
    } else if (settings === undefined) {
      facts.push(t`Access not shown`);
    } else {
      const classes = classesOn(settings);
      facts.push(
        audienceLine(settings.audience),
        classes.on === 0
          ? t`May do nothing yet`
          : t`${classes.on} of ${classes.of} kinds of work`
      );
    }
    const scheduled = wakesOn(managed.wakes).length;
    if (scheduled > 0) {
      facts.push(
        plural(scheduled, { one: "# schedule", other: "# schedules" })
      );
    }
    if (usage !== undefined && usage.requests > 0) {
      const spent = dollars(usage.spent);
      facts.push(t`${spent} this month`);
    }
    return facts;
  };
};

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
      usage: managed.usage[agent.id],
    },
  }));
};

/** The card's picture: the agent on its own night, asleep while paused, turning to the pointer. */
const Stage = ({ shown }: { shown: Shown }) => {
  const [near, setNear] = useState(false);
  const look = lookOf(shown);
  const paused = shown.managed?.state === "paused";
  let state: FigureState = "idle";
  if (paused) {
    state = "asleep";
  } else if (near) {
    state = "listening";
  }
  return (
    <CardMedia>
      <span
        onPointerEnter={() => {
          setNear(true);
        }}
        onPointerLeave={() => {
          setNear(false);
        }}
        {...stylex.props(styles.stage)}
      >
        {/* Mounted anew when it pauses or wakes: its light is drawn for one or the other. */}
        <AgentAura
          bright={paused ? 0.45 : 1}
          key={paused ? "asleep" : "awake"}
          look={look}
        />
        <AgentFigure look={look} size="lg" state={state} />
      </span>
    </CardMedia>
  );
};

/** The card's words: the name, a Paused badge while it rests, its job and the facts. */
const Words = ({
  shown,
  facts,
}: {
  shown: Shown;
  facts: readonly string[];
}) => {
  const { t } = useLingui();
  const paused = shown.managed?.state === "paused";
  return (
    <span {...stylex.props(styles.words)}>
      <span {...stylex.props(styles.title)}>
        <CardTitle>{shown.name}</CardTitle>
        {paused ? (
          <Badge size="sm" tone="neutral">
            {t`Paused`}
          </Badge>
        ) : null}
      </span>
      <CardDescription>
        {shown.job === "" ? t`No job written yet` : shown.job}
      </CardDescription>
      {facts.length === 0 ? null : (
        <Text element="span" size="xs" tone="quiet">
          {facts.join(" · ")}
        </Text>
      )}
    </span>
  );
};

/**
 * One agent's card. For an admin the whole card opens the agent's page; for anyone else, an agent
 * they may talk to opens a chat with it.
 */
const AgentCard = ({
  shown,
  facts,
}: {
  shown: Shown;
  facts: readonly string[];
}) => {
  const { t } = useLingui();
  const inside = (
    <>
      <Stage shown={shown} />
      <Words facts={facts} shown={shown} />
    </>
  );
  if (shown.managed !== undefined) {
    return (
      <CardLink
        render={<Link params={{ agent: shown.id }} to="/agents/$agent" />}
      >
        {inside}
      </CardLink>
    );
  }
  if (shown.usable) {
    const { name } = shown;
    return (
      <CardLink
        aria-label={t`Chat with ${name}`}
        render={<Link search={{ agent: shown.id }} to="/" />}
      >
        {inside}
      </CardLink>
    );
  }
  return <Card>{inside}</Card>;
};

/** The Agents page's body: the agents the person may `usable`, and what an admin `managed`. */
export const AgentsOverview = ({
  usable,
  managed,
  makes,
}: {
  usable: readonly ChatAgent[];
  managed: ManagedAgents | undefined;
  /** Whether the person may make an agent: the company's own admins. */
  makes: boolean;
}) => {
  const { t } = useLingui();
  const factsOf = useFacts(managed?.teams ?? []);
  const agents = shownOf(usable, managed);
  const newAgent = makes ? (
    <Button icon={Plus} render={<Link to="/agents/new" />} variant="ink">
      {t`New agent`}
    </Button>
  ) : undefined;
  return (
    <Page>
      <PageHeading action={newAgent} title={t`Agents`} />
      {agents.length === 0 ? (
        <Empty size="page">
          <EmptyHeader>
            <EmptyMedia icon={AgentPerson} />
            <EmptyTitle>{t`No agents yet`}</EmptyTitle>
            {/* Only who can make one is told what to do. */}
            {managed === undefined ? null : (
              <EmptyDescription>
                {t`Make one for a job, such as chasing unpaid invoices.`}
              </EmptyDescription>
            )}
          </EmptyHeader>
          {newAgent === undefined ? null : (
            <EmptyContent>{newAgent}</EmptyContent>
          )}
        </Empty>
      ) : (
        <ul aria-label={t`Agents`} {...stylex.props(styles.grid)}>
          {agents.map((agent) => (
            <li key={agent.id}>
              <AgentCard
                facts={
                  agent.managed === undefined ? [] : factsOf(agent.managed)
                }
                shown={agent}
              />
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
};
