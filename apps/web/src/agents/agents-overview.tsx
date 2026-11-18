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
import { Heading } from "../grasp/heading/index.ts";
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
  // CONCEPT A, Night: the card is the agent's night, the words light on it.
  night: {
    position: "relative",
    display: "grid",
    gridTemplateRows: "1fr auto",
    minHeight: "21rem",
    isolation: "isolate",
    colorScheme: "dark",
    color: grasp.text,
  },
  nightFigure: {
    position: "relative",
    zIndex: 1,
    display: "grid",
    placeItems: "center",
    paddingBlockStart: grasp.space6,
  },
  nightWords: {
    position: "relative",
    zIndex: 1,
    display: "grid",
    gap: grasp.space1,
    padding: grasp.space5,
  },
  // CONCEPT B, Paper: the figure on the card's own paper, centred, nothing round it.
  paper: {
    display: "grid",
    justifyItems: "center",
    textAlign: "center",
    gap: grasp.space1,
    paddingBlock: grasp.space4,
  },
  paperFigure: { marginBlockEnd: grasp.space3 },
  // CONCEPT C, Tile: a small night tile beside the words.
  tileGrid: {
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 22rem), 1fr))",
  },
  tile: { display: "flex", alignItems: "center", gap: grasp.space4 },
  tileArt: {
    position: "relative",
    display: "grid",
    flexShrink: 0,
    placeItems: "center",
    width: "6rem",
    height: "6rem",
    overflow: "hidden",
    borderRadius: grasp.corner,
    isolation: "isolate",
  },
  tileWords: { display: "grid", gap: grasp.space1, minWidth: 0 },
  // CONCEPT D, Edge: the picture runs to the card's edges, the words under it with room.
  edge: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    aspectRatio: "16 / 11",
    isolation: "isolate",
  },
  edgeWords: { display: "grid", gap: grasp.space1, padding: grasp.space4 },
  // CONCEPT E, Portrait: a tall night card, the name large in the serif, the figure large and
  // cropped by the card's corner.
  portrait: {
    position: "relative",
    display: "grid",
    alignContent: "start",
    gap: grasp.space2,
    minHeight: "20rem",
    padding: grasp.space5,
    overflow: "hidden",
    isolation: "isolate",
    colorScheme: "dark",
    color: grasp.text,
  },
  portraitFigure: {
    position: "absolute",
    insetBlockEnd: "-3rem",
    insetInlineEnd: "-3rem",
    zIndex: 0,
  },
  portraitWords: {
    position: "relative",
    zIndex: 1,
    display: "grid",
    gap: grasp.space2,
    maxWidth: "70%",
  },
  portraitFoot: {
    position: "absolute",
    insetBlockEnd: grasp.space5,
    insetInlineStart: grasp.space5,
    zIndex: 1,
  },
});

/** CONCEPT: which card the page draws, from `?card=` in the address. */
type Concept = "a" | "b" | "c" | "d" | "e";
const conceptOf = (): Concept => {
  const asked =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("card");
  return asked === "a" ||
    asked === "b" ||
    asked === "c" ||
    asked === "d" ||
    asked === "e"
    ? asked
    : "a";
};

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

/** CONCEPT: the pose a card's figure takes: asleep while paused, turning to a pointer on it. */
const usePose = (shown: Shown) => {
  const [near, setNear] = useState(false);
  const paused = shown.managed?.state === "paused";
  let state: FigureState = "idle";
  if (paused) {
    state = "asleep";
  } else if (near) {
    state = "listening";
  }
  return {
    state,
    paused,
    near: {
      onPointerEnter: () => {
        setNear(true);
      },
      onPointerLeave: () => {
        setNear(false);
      },
    },
  };
};

/** CONCEPT: the job, and the facts in a quiet line. */
const JobAndFacts = ({
  shown,
  facts,
}: {
  shown: Shown;
  facts: readonly string[];
}) => {
  const { t } = useLingui();
  return (
    <>
      <CardDescription>
        {shown.job === "" ? t`No job written yet` : shown.job}
      </CardDescription>
      {facts.length === 0 ? null : (
        <Text element="span" size="xs" tone="quiet">
          {facts.join(" · ")}
        </Text>
      )}
    </>
  );
};

/** CONCEPT: the name, with Paused beside it while it rests. */
const NameLine = ({ shown }: { shown: Shown }) => {
  const { t } = useLingui();
  return (
    <span {...stylex.props(styles.title)}>
      <CardTitle>{shown.name}</CardTitle>
      {shown.managed?.state === "paused" ? (
        <Badge size="sm" tone="neutral">
          {t`Paused`}
        </Badge>
      ) : null}
    </span>
  );
};

/** CONCEPT: one card's inside, drawn as concept `concept`. */
const Concepted = ({
  concept,
  shown,
  facts,
}: {
  concept: Concept;
  shown: Shown;
  facts: readonly string[];
}) => {
  const { t } = useLingui();
  const look = lookOf(shown);
  const { state, paused, near } = usePose(shown);
  const aura = (
    <AgentAura
      bright={paused ? 0.45 : 1}
      key={paused ? "asleep" : "awake"}
      look={look}
    />
  );
  if (concept === "a") {
    return (
      <span {...near} {...stylex.props(styles.night)}>
        {aura}
        <span {...stylex.props(styles.nightFigure)}>
          <AgentFigure look={look} size="lg" state={state} />
        </span>
        <span {...stylex.props(styles.nightWords)}>
          <NameLine shown={shown} />
          <JobAndFacts facts={facts} shown={shown} />
        </span>
      </span>
    );
  }
  if (concept === "b") {
    return (
      <span {...near} {...stylex.props(styles.paper)}>
        <span {...stylex.props(styles.paperFigure)}>
          <AgentFigure look={look} size="lg" state={state} />
        </span>
        <NameLine shown={shown} />
        <JobAndFacts facts={facts} shown={shown} />
      </span>
    );
  }
  if (concept === "c") {
    return (
      <span {...near} {...stylex.props(styles.tile)}>
        <span {...stylex.props(styles.tileArt)}>
          {aura}
          <AgentFigure look={look} size="md" state={state} />
        </span>
        <span {...stylex.props(styles.tileWords)}>
          <NameLine shown={shown} />
          <JobAndFacts facts={facts} shown={shown} />
        </span>
      </span>
    );
  }
  if (concept === "d") {
    return (
      <>
        <CardMedia>
          <span {...near} {...stylex.props(styles.edge)}>
            {aura}
            <AgentFigure look={look} size="lg" state={state} />
          </span>
        </CardMedia>
        <span {...stylex.props(styles.edgeWords)}>
          <NameLine shown={shown} />
          <JobAndFacts facts={facts} shown={shown} />
        </span>
      </>
    );
  }
  return (
    <span {...near} {...stylex.props(styles.portrait)}>
      {aura}
      <span {...stylex.props(styles.portraitFigure)}>
        <AgentFigure look={look} size="xl" state={state} />
      </span>
      <span {...stylex.props(styles.portraitWords)}>
        <Heading level={3} size="md">
          {shown.name}
        </Heading>
        <CardDescription>
          {shown.job === "" ? t`No job written yet` : shown.job}
        </CardDescription>
      </span>
      <span {...stylex.props(styles.portraitFoot)}>
        {paused ? (
          <Badge size="sm" tone="neutral">
            {t`Paused`}
          </Badge>
        ) : (
          <Text element="span" size="xs" tone="quiet">
            {facts.at(0) ?? ""}
          </Text>
        )}
      </span>
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
  const concept = conceptOf();
  const inside = <Concepted concept={concept} facts={facts} shown={shown} />;
  // A, D and E run to the card's edges: their own room is inside them.
  const padding = concept === "b" || concept === "c" ? "md" : "none";
  if (shown.managed !== undefined) {
    return (
      <CardLink
        padding={padding}
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
        padding={padding}
        render={<Link search={{ agent: shown.id }} to="/" />}
      >
        {inside}
      </CardLink>
    );
  }
  return <Card padding={padding}>{inside}</Card>;
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
        <ul
          aria-label={t`Agents`}
          {...stylex.props(styles.grid, conceptOf() === "c" && styles.tileGrid)}
        >
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
