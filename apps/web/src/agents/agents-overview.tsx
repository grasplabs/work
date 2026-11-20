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
import type { ReactNode } from "react";

import { Page, PageHeading } from "../frame/page.tsx";
import { AgentFigure, AgentFigureAura } from "../grasp/agent-figure/index.ts";
import type { AgentFigureState } from "../grasp/agent-figure/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Card, CardDescription, CardLink } from "../grasp/card/index.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTitle,
  HoverCardTrigger,
} from "../grasp/hover-card/index.ts";
import { AgentPerson, Plus } from "../grasp/icons/index.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import type { KeyValueItem } from "../grasp/key-value/key-value.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../grasp/tabs/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { dollars } from "../settings/money.ts";
import {
  classesOn,
  nextWakeAt,
  useAudienceLine,
  wakesOn,
} from "./agent-facts.tsx";
import { useLast } from "./agent-wakes.tsx";
import { lookOf } from "./figure/look.ts";

// The Agents page: the company's agents as portraits, Ruben's pick of the card concepts (E). Each
// card is the agent's own night (its aura, dithered in its palette), its name large in the serif at
// the top with its job under it, its figure (Damsko's Stephen in the shape and palette it was
// given, figure/) large and cropped by the card's corner, and one fact at its foot. The whole card
// is one link. A figure draws only while on screen and is a still under reduced motion; a paused
// agent sleeps.
//
// Everyone sees the agents they may talk to (`chats.agents`), and their card opens a chat with it.
// The company's admins see every agent (`connections.agents`), and its card opens its page; resting
// on one, or reaching it with the keys, opens the library's HoverCard with what is worth knowing
// before opening it: whom it answers, what it may do, whether it works on its own and when next,
// this month's use and its last run. A touch screen has no hover, and a tap follows the link: there
// the facts that matter most stand on the card itself.
//
// An admin's agents stand under two tabs, by whom each answers: My agents, the ones that answer
// nobody else yet, and Organization, the ones that answer everyone or some teams, the company's
// first among them. Core keeps no maker, so an agent that answers nobody else is every admin's.
// The tab is in the address (`?tab=`). Anyone else has only the agents shared with them, and so
// no tabs.

/** The overview's tabs, by the names its address carries. */
export const agentsTabs = ["mine", "organization"] as const;
export type AgentsTab = (typeof agentsTabs)[number];

/** The tab an address names; none for any other. */
export const agentsTabOf = (value: unknown): AgentsTab | undefined =>
  agentsTabs.find((tab) => tab === value);

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
  // The room between the tabs and the cards: with the tab panel's own 16px, the page gap (24px).
  tabsRoom: { marginBlockEnd: grasp.space2 },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 16rem), 1fr))",
    gap: grasp.space4,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // The hover card's anchor: the card's own box.
  anchor: { display: "grid" },
  // The portrait: the agent's light on the page's own ground, light in a light
  // theme and deep in a dark one, its words in the theme's own ink.
  portrait: {
    position: "relative",
    display: "grid",
    alignContent: "start",
    minHeight: "20rem",
    padding: grasp.space5,
    overflow: "hidden",
    // The card's own corner: the night is clipped to it.
    borderRadius: "inherit",
    cornerShape: grasp.cornerShape,
    isolation: "isolate",
  },
  // Large, and cropped by the card's end corner.
  figure: {
    position: "absolute",
    insetBlockEnd: "-3.5rem",
    insetInlineEnd: "-3.5rem",
    zIndex: 0,
  },
  words: {
    position: "relative",
    zIndex: 1,
    display: "grid",
    gap: grasp.space2,
    maxWidth: "75%",
  },
  // The foot: clear of the figure, at the card's start corner.
  foot: {
    position: "absolute",
    insetBlockEnd: grasp.space5,
    insetInlineStart: grasp.space5,
    zIndex: 1,
    display: "grid",
    justifyItems: "start",
    gap: grasp.space1,
    // Clear of the figure, which takes the card's end half at its foot.
    maxWidth: "40%",
  },
  // Said on the card only where nothing can hover: the HoverCard says it elsewhere.
  touchOnly: {
    display: { default: "block", [media.hover]: "none" },
  },
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
type Managed = NonNullable<Shown["managed"]>;

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

/**
 * The tab an agent stands under: My agents while it answers nobody else, Organization once it
 * answers everyone or some teams, as the company's first always does and one whose access core
 * didn't say.
 */
const tabOf = ({ managed }: Shown): AgentsTab =>
  managed?.first === false && managed.settings?.audience.who === "nobody"
    ? "mine"
    : "organization";

/** The wake-up that ran last, if any did. */
const lastRunOf = (wakes: readonly AgentWake[]): AgentWake | undefined =>
  wakes
    .filter(({ lastAt }) => lastAt !== null)
    .toSorted((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""))
    .at(0);

/** Whether a wake-up's last run didn't start. */
const failed = (wake: AgentWake | undefined): boolean =>
  wake?.lastOutcome !== undefined &&
  wake.lastOutcome !== null &&
  wake.lastOutcome !== "started";

/** What an admin reads of an agent: its rows for the HoverCard and the few that stand on its card. */
interface Facts {
  /** Everything worth knowing before opening it, a row each. */
  rows: KeyValueItem[];
  /** The one fact at the card's foot. */
  foot: string;
  /** What a touch screen adds under it, where nothing hovers. */
  touch: string[];
  /** Its last run didn't start. */
  failed: boolean;
}

/**
 * What there is to know of an agent before opening it. Whom it answers (the first agent everyone
 * with Grasp; another its own audience, or that it isn't shown where core didn't say, never passed
 * off as everyone), how much it may do, whether it works on its own and when next, this month's use
 * and how its last run went.
 */
const useFacts = (teams: StephenReach["teams"]) => {
  const { t, i18n } = useLingui();
  const audienceLine = useAudienceLine(teams);
  const lastLine = useLast();
  const moment = (iso: string): string =>
    new Intl.DateTimeFormat(i18n.locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  return (managed: Managed): Facts => {
    const { settings, first, usage, wakes } = managed;
    const rows: KeyValueItem[] = [];
    let answers = t`Access not shown`;
    if (first) {
      answers = t`Everyone with Grasp`;
    } else if (settings !== undefined) {
      answers = audienceLine(settings.audience);
    }
    rows.push({ key: t`Answers`, value: answers });
    if (!first && settings !== undefined) {
      const classes = classesOn(settings);
      rows.push({
        key: t`May do`,
        value:
          classes.on === 0
            ? t`Nothing yet`
            : t`${classes.on} of ${classes.of} kinds of work`,
      });
    }
    const scheduled = wakesOn(wakes).length;
    const next = nextWakeAt(wakes);
    let own = t`Only when asked`;
    if (next !== undefined) {
      const nextMoment = moment(next);
      own = t`Next ${nextMoment}`;
    } else if (scheduled > 0) {
      own = plural(scheduled, { one: "# schedule", other: "# schedules" });
    }
    rows.push({ key: t`On its own`, value: own });
    if (usage !== undefined && usage.requests > 0) {
      const spent = dollars(usage.spent);
      const { requests, people } = usage;
      const count = plural(requests, {
        one: "# request",
        other: "# requests",
      });
      const reach = plural(people, { one: "# person", other: "# people" });
      rows.push({
        key: t`This month`,
        value: t`${spent} · ${count} · ${reach}`,
      });
    }
    const ran = lastRunOf(wakes);
    const ranLine = ran === undefined ? undefined : lastLine(ran);
    if (ranLine !== undefined) {
      rows.push({ key: t`Last run`, value: ranLine });
    }
    if (usage?.lastAt !== undefined && usage.lastAt !== null) {
      rows.push({ key: t`Last asked`, value: moment(usage.lastAt) });
    }
    return {
      rows,
      foot: next === undefined ? answers : own,
      touch: next === undefined ? [] : [answers],
      failed: failed(ran),
    };
  };
};

/** The figure's pose: asleep while paused, listening while a pointer rests on its card. */
const usePose = (paused: boolean) => {
  const [near, setNear] = useState(false);
  let state: AgentFigureState = "idle";
  if (paused) {
    state = "asleep";
  } else if (near) {
    state = "listening";
  }
  return {
    state,
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

/** The card's foot: Paused while it rests, a failed last run, else its one fact. */
const Foot = ({
  paused,
  facts,
}: {
  paused: boolean;
  facts: Facts | undefined;
}) => {
  const { t } = useLingui();
  if (facts === undefined) {
    return null;
  }
  return (
    <span {...stylex.props(styles.foot)}>
      {paused ? (
        <Badge size="sm" tone="neutral">
          {t`Paused`}
        </Badge>
      ) : null}
      {facts.failed ? (
        <Badge size="sm" tone="danger">
          {t`Last run failed`}
        </Badge>
      ) : null}
      {facts.touch.map((line) => (
        <span key={line} {...stylex.props(styles.touchOnly)}>
          <Text element="span" size="xs" tone="quiet">
            {line}
          </Text>
        </span>
      ))}
      {paused ? null : (
        <Text element="span" size="xs" tone="quiet">
          {facts.foot}
        </Text>
      )}
    </span>
  );
};

/** One agent's portrait: its night, its name and job, its figure in the corner, its foot. */
const Portrait = ({
  shown,
  facts,
}: {
  shown: Shown;
  facts: Facts | undefined;
}) => {
  const { t } = useLingui();
  const look = lookOf(shown);
  const paused = shown.managed?.state === "paused";
  const { state, near } = usePose(paused);
  return (
    <span {...near} {...stylex.props(styles.portrait)}>
      {/* Mounted anew when it pauses or wakes: its light is drawn for one or the other. */}
      <AgentFigureAura
        bright={paused ? 0.45 : 1}
        // On the page's own ground: light green in a light theme, deep in a dark one (Ruben).
        ground="page"
        key={paused ? "asleep" : "awake"}
        look={look}
      />
      <span {...stylex.props(styles.figure)}>
        <AgentFigure look={look} size="xl" state={state} />
      </span>
      <span {...stylex.props(styles.words)}>
        <Heading level={2} size="md">
          {shown.name}
        </Heading>
        <CardDescription>
          {shown.job === "" ? t`No job written yet` : shown.job}
        </CardDescription>
      </span>
      <Foot facts={facts} paused={paused} />
    </span>
  );
};

/** The HoverCard round an admin's card: the card stays the one link, the details open beside it. */
const WithDetails = ({
  shown,
  facts,
  children,
}: {
  shown: Shown;
  facts: Facts;
  children: ReactNode;
}) => (
  <HoverCard>
    {/* The card is the link; the trigger is only the box the card opens beside. */}
    <HoverCardTrigger
      render={<div {...stylex.props(styles.anchor)} />}
      variant="plain"
    >
      {children}
    </HoverCardTrigger>
    <HoverCardContent align="start" side="right" width="content">
      <HoverCardTitle>{shown.name}</HoverCardTitle>
      <KeyValueList items={facts.rows} variant="inline" />
    </HoverCardContent>
  </HoverCard>
);

/**
 * One agent's card. For an admin the whole card opens the agent's page, with its details on hover;
 * for anyone else, an agent they may talk to opens a chat with it.
 */
const AgentCard = ({
  shown,
  facts,
}: {
  shown: Shown;
  facts: Facts | undefined;
}) => {
  const { t } = useLingui();
  const inside = <Portrait facts={facts} shown={shown} />;
  if (shown.managed !== undefined && facts !== undefined) {
    return (
      <WithDetails facts={facts} shown={shown}>
        <CardLink
          padding="none"
          render={<Link params={{ agent: shown.id }} to="/agents/$agent" />}
        >
          {inside}
        </CardLink>
      </WithDetails>
    );
  }
  if (shown.usable) {
    const { name } = shown;
    return (
      <CardLink
        aria-label={t`Chat with ${name}`}
        padding="none"
        render={<Link search={{ agent: shown.id }} to="/" />}
      >
        {inside}
      </CardLink>
    );
  }
  return <Card padding="none">{inside}</Card>;
};

/** The agents as cards in a grid. */
const AgentGrid = ({
  agents,
  teams,
}: {
  agents: readonly Shown[];
  teams: StephenReach["teams"];
}) => {
  const { t } = useLingui();
  const factsOf = useFacts(teams);
  return (
    <ul aria-label={t`Agents`} {...stylex.props(styles.grid)}>
      {agents.map((agent) => (
        <li key={agent.id}>
          <AgentCard
            facts={
              agent.managed === undefined ? undefined : factsOf(agent.managed)
            }
            shown={agent}
          />
        </li>
      ))}
    </ul>
  );
};

/** An admin's agents under their two tabs, the chosen one's shown. */
const AgentTabs = ({
  agents,
  teams,
  tab,
  onTab,
}: {
  agents: readonly Shown[];
  teams: StephenReach["teams"];
  tab: AgentsTab | undefined;
  onTab: (tab: AgentsTab) => void;
}) => {
  const { t } = useLingui();
  const under = (each: AgentsTab) =>
    agents.filter((agent) => tabOf(agent) === each);
  const tabName = { mine: t`My agents`, organization: t`Organization` };
  const none = {
    mine: t`Agents only you can use stand here.`,
    organization: t`Your company has no other agents yet.`,
  };
  return (
    <Tabs
      onValueChange={(value) => {
        const chosen = agentsTabOf(value);
        if (chosen !== undefined) {
          onTab(chosen);
        }
      }}
      // With no tab in the address, the first with agents in it.
      value={tab ?? agentsTabs.find((each) => under(each).length > 0) ?? "mine"}
    >
      <div {...stylex.props(styles.tabsRoom)}>
        <TabsList aria-label={t`Agents`}>
          {agentsTabs.map((each) => (
            <TabsTrigger key={each} value={each}>
              {tabName[each]}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {agentsTabs.map((each) => (
        <TabsContent key={each} value={each}>
          {under(each).length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia picture="nothing" />
                <EmptyDescription>{none[each]}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <AgentGrid agents={under(each)} teams={teams} />
          )}
        </TabsContent>
      ))}
    </Tabs>
  );
};

/**
 * The Agents page's body: the agents the person may `usable`, and what an admin `managed`, under
 * the `tab` the address names.
 */
export const AgentsOverview = ({
  usable,
  managed,
  makes,
  tab,
  onTab,
}: {
  usable: readonly ChatAgent[];
  managed: ManagedAgents | undefined;
  /** Whether the person may make an agent: the company's own admins. */
  makes: boolean;
  /** The tab the address names; none shows the first with agents in it. */
  tab: AgentsTab | undefined;
  /** Puts the tab chosen in the address. */
  onTab: (tab: AgentsTab) => void;
}) => {
  const { t } = useLingui();
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
      ) : null}
      {agents.length > 0 && managed !== undefined ? (
        <AgentTabs
          agents={agents}
          onTab={onTab}
          tab={tab}
          teams={managed.teams}
        />
      ) : null}
      {agents.length > 0 && managed === undefined ? (
        <AgentGrid agents={agents} teams={[]} />
      ) : null}
    </Page>
  );
};
