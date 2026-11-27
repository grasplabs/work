import type {
  Agent,
  AgentSettings,
  AgentUsage,
  AgentWake,
} from "@grasp-os/shared/agents";
import type { ChatAgent } from "@grasp-os/shared/chat";
import type { Member } from "@grasp-os/shared/members";
import type { StephenReach } from "@grasp-os/shared/stephen-reach";
import { AppShellPage } from "@grasp-os/ui/blocks/app-shell-01/app-shell-01";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import { Tabs, TabsContent } from "@grasp-os/ui/components/tabs";
import { Icon, PlusIcon, UserSparklesIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { modelName } from "../chat/composer.tsx";
import { formatDollars } from "../format.ts";
import { pageText } from "../frame/page-text.ts";
import { AgentCard, agentCardStyles } from "./agent-card.tsx";
import type { AgentCardFact } from "./agent-card.tsx";
import { nextWakeAt, useAudienceLine, wakesOn } from "./agent-facts.tsx";
import { OfferedAgents } from "./agent-share.tsx";
import { lookOf } from "./figure/look.ts";
import { AgentTabList, agentsTabOf } from "./tabs.tsx";
import type { AgentsTab } from "./tabs.tsx";

// The Agents page: the agents as portraits, on the library's AgentCard: the agent's own light on the
// page's ground, its name in the serif with its job under it, its figure (in the shape and palette
// it was given, figure/) large and cropped by the card's corner, and whom it answers as a pill at
// its foot. The whole card is one link. A paused agent sleeps, and says so.
//
// Everyone sees the agents they may talk to (`chats.agents`), and their card opens a chat with it,
// the agent mentioned in its box. A person's own agents (`connections.ownAgents`), which nobody else
// sees, stand first, each opening its page. The company's admins see every agent of the company
// (`connections.agents`), and its card opens its page; resting on one, or reaching it with the
// keys, grows three facts inside the card: whether it works on its own and when next, its model,
// and this month's use.
//
// An admin's agents stand under two tabs: My agents, their own agents and nobody else's, and
// Organization, every agent of the company, the company's first among them, with the agents people
// offered the company (agent-share.tsx) and people's own agents (own-agents-admin.tsx) under them.
// The tab is in the address (`?tab=`). Anyone else has only their own and the agents shared with
// them, and so no tabs.

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
  // The person's own and the company's, a group each.
  groups: { display: "grid", gap: space["7"] },
  group: { display: "grid", gap: space["4"] },
  // The room between the tabs and the cards: with the tab panel's own 16px, the page gap (24px).
  tabsRoom: { marginBlockEnd: space["2"] },
});

/** What a card shows of one agent. */
interface Shown {
  id: string;
  name: string;
  job: string;
  /** The look it was given, as core keeps it. */
  face: string;
  /** Whether it answers, for one of the person's own; undefined for any other. */
  own?: Agent["state"];
  /** As an admin reads it; undefined for anyone else. */
  managed:
    | {
        state: Agent["state"];
        first: boolean;
        /** The model its turns use; null for the one its asker picks. */
        model: string | null;
        settings: AgentSettings | undefined;
        wakes: readonly AgentWake[];
        usage: AgentUsage | undefined;
      }
    | undefined;
}
type Managed = NonNullable<Shown["managed"]>;

/** The cards of the person's own agents, each opening its page. */
const ownShownOf = (own: readonly Agent[]): Shown[] =>
  own.map(({ id, name, job, face, state }) => ({
    id,
    name,
    job,
    face,
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
      managed: undefined,
    }));
  }
  const [first] = managed.agents;
  return managed.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    job: agent.job,
    face: agent.face,
    managed: {
      state: agent.state,
      first: agent.id === first?.id,
      model: agent.model,
      settings: managed.settings[agent.id],
      wakes: managed.wakes[agent.id] ?? [],
      usage: managed.usage[agent.id],
    },
  }));
};

/** The wake-up that ran last, if any did. */
const lastRunOf = (wakes: readonly AgentWake[]): AgentWake | undefined =>
  wakes
    .filter(({ lastAt }) => lastAt !== null)
    .toSorted((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""))
    .at(0);

/** Whether a wake-up's last run failed: a paused or busy agent's skip is no failure, as its page says. */
const failed = (wake: AgentWake | undefined): boolean =>
  wake?.lastOutcome !== undefined &&
  wake.lastOutcome !== null &&
  wake.lastOutcome !== "started" &&
  wake.lastOutcome !== "agent.paused" &&
  wake.lastOutcome !== "agent.busy";

/** What a card says of an agent beyond its name and job. */
interface Facts {
  /** Whom it answers, as the pill at the card's foot; none where core didn't say. */
  audience: string | undefined;
  /** What grows inside the card: on its own, its model, this month. */
  details: AgentCardFact[];
  /** Its last run didn't start. */
  failed: boolean;
}

/**
 * What an admin's card says of an agent before it is opened. Whom it answers: everyone, its teams or
 * nobody yet, and nothing where core didn't say, never passed off as everyone. Then whether it works
 * on its own and when next, its model, and this month's use.
 */
const useFacts = (teams: StephenReach["teams"]) => {
  const { t, i18n } = useLingui();
  const audienceLine = useAudienceLine(teams);
  // Short enough for one line of the card: the day and the time.
  const moment = (iso: string): string =>
    new Intl.DateTimeFormat(i18n.locale, {
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  return ({ settings, first, model, usage, wakes }: Managed): Facts => {
    let audience: string | undefined;
    if (first) {
      audience = t`Everyone`;
    } else if (settings !== undefined) {
      audience = audienceLine(settings.audience);
    }
    const scheduled = wakesOn(wakes).length;
    const next = nextWakeAt(wakes);
    let own = t`Only when asked`;
    if (next !== undefined) {
      own = moment(next);
    } else if (scheduled > 0) {
      own = plural(scheduled, { one: "# schedule", other: "# schedules" });
    }
    return {
      audience,
      details: [
        { key: t`On its own`, value: own },
        {
          key: t`Model`,
          value: model === null ? t`The asker's` : modelName(model),
        },
        // Left out where core didn't say what it used.
        ...(usage === undefined
          ? []
          : [{ key: t`This month`, value: formatDollars(usage.spent) }]),
      ],
      failed: failed(lastRunOf(wakes)),
    };
  };
};

/**
 * One agent's card. For an admin the whole card opens the agent's page, with whom it answers at its
 * foot and its details on hover and focus; one of the person's own opens its page too; for anyone
 * else it opens a chat with the agent mentioned.
 */
const AgentPortrait = ({
  shown,
  facts,
}: {
  shown: Shown;
  facts: Facts | undefined;
}) => {
  const { t } = useLingui();
  const { name } = shown;
  const job = shown.job === "" ? t`No job written yet` : shown.job;
  const look = lookOf(shown);
  if (facts === undefined) {
    return (
      <AgentCard
        aria-label={t`Chat with ${name}`}
        headingLevel={2}
        job={job}
        look={look}
        name={name}
        opens={{ chat: shown.id }}
      />
    );
  }
  const paused = (shown.managed?.state ?? shown.own) === "paused";
  return (
    <AgentCard
      audience={facts.audience}
      details={facts.details}
      headingLevel={2}
      job={job}
      look={look}
      name={name}
      paused={paused}
      opens={{ page: shown.id }}
      status={
        paused || facts.failed ? (
          <>
            {paused ? (
              <Badge size="sm" variant="default">
                {t`Paused`}
              </Badge>
            ) : null}
            {facts.failed ? (
              <Badge size="sm" variant="destructive">
                {t`Last run failed`}
              </Badge>
            ) : null}
          </>
        ) : undefined
      }
    />
  );
};

/** A group of agents' cards. */
const AgentGrid = ({
  agents,
  facts,
  label,
}: {
  agents: readonly Shown[];
  facts: (shown: Shown) => Facts | undefined;
  label: string;
}) => (
  <ul aria-label={label} {...stylex.props(agentCardStyles.grid)}>
    {agents.map((agent) => (
      <li key={agent.id}>
        <AgentPortrait facts={facts(agent)} shown={agent} />
      </li>
    ))}
  </ul>
);

/** The person's own agents first, then the company's, told apart only where there are both. */
const AgentGroups = ({
  mine,
  agents,
  facts,
}: {
  mine: readonly Shown[];
  agents: readonly Shown[];
  facts: (shown: Shown) => Facts | undefined;
}) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.groups)}>
      {mine.length === 0 ? null : (
        <section {...stylex.props(styles.group)}>
          <SectionHeader
            description={t`Only you see and ask these.`}
            size="sm"
            title={t`Yours`}
          />
          <AgentGrid agents={mine} facts={facts} label={t`Your agents`} />
        </section>
      )}
      {agents.length === 0 ? null : (
        <section {...stylex.props(styles.group)}>
          {mine.length === 0 ? null : (
            <SectionHeader size="sm" title={t`Your company's`} />
          )}
          <AgentGrid agents={agents} facts={facts} label={t`Agents`} />
        </section>
      )}
    </div>
  );
};

/**
 * An admin's agents under their two tabs, the chosen one's shown: their own (`mine`) under My
 * agents, and every agent of the company with what an admin keeps of it (`company`) under
 * Organization.
 */
const AgentTabs = ({
  mine,
  agents,
  facts,
  company,
  tab,
  onTab,
}: {
  mine: readonly Shown[];
  agents: readonly Shown[];
  facts: (shown: Shown) => Facts | undefined;
  company: ReactNode;
  tab: AgentsTab | undefined;
  onTab: (tab: AgentsTab) => void;
}) => {
  const { t } = useLingui();
  return (
    <Tabs
      onValueChange={(value) => {
        const chosen = agentsTabOf(value);
        if (chosen !== undefined) {
          onTab(chosen);
        }
      }}
      // With no tab in the address, My agents while there are any, else the company's.
      value={tab ?? (mine.length > 0 ? "mine" : "organization")}
    >
      <div {...stylex.props(styles.tabsRoom)}>
        <AgentTabList />
      </div>
      <TabsContent value="mine">
        {mine.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia illustration="nothing" />
              <EmptyDescription>
                {t`Agents only you can use stand here.`}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <AgentGrid agents={mine} facts={facts} label={t`Your agents`} />
        )}
      </TabsContent>
      <TabsContent value="organization">
        {/* Never empty: the company's first agent is always the organization's. */}
        <div {...stylex.props(styles.groups)}>
          <AgentGrid agents={agents} facts={facts} label={t`Agents`} />
          {company}
        </div>
      </TabsContent>
    </Tabs>
  );
};

/**
 * The Agents page's body: the person's `own` agents, the company's they may `usable`, and what an
 * admin `managed`, under the `tab` the address names.
 */
export const AgentsOverview = ({
  usable,
  managed,
  own,
  makes,
  makesOwn,
  offered,
  tab,
  onTab,
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
  /** The tab the address names; none shows the first with agents in it. */
  tab: AgentsTab | undefined;
  /** Puts the tab chosen in the address. */
  onTab: (tab: AgentsTab) => void;
}) => {
  const { t } = useLingui();
  const factsOf = useFacts(managed?.teams ?? []);
  const agents = shownOf(usable, managed);
  const mine = ownShownOf(own);
  // One of the person's own says at its foot that it is theirs alone.
  const facts = (shown: Shown): Facts | undefined => {
    if (shown.managed !== undefined) {
      return factsOf(shown.managed);
    }
    return shown.own === undefined
      ? undefined
      : { audience: t`Just for me`, details: [], failed: false };
  };
  const newAgent =
    makes || makesOwn ? (
      <Button asChild size="sm">
        <Link to="/agents/new">
          <Icon icon={PlusIcon} />
          {t`New agent`}
        </Link>
      </Button>
    ) : undefined;
  let emptyLine: string | undefined;
  if (managed !== undefined) {
    emptyLine = t`Make one for a job, such as chasing unpaid invoices.`;
  } else if (makesOwn) {
    emptyLine = t`The agents your company sets up for you show here. You can also make one of your own.`;
  }
  const none = agents.length === 0 && mine.length === 0;
  const company =
    offered === undefined ? null : (
      <OfferedAgents
        editable={makes}
        offered={offered.agents}
        people={offered.people}
      />
    );
  return (
    <AppShellPage>
      <div {...stylex.props(pageText.text)}>
        <PageHeader actions={newAgent} title={t`Agents`} />
        {none ? (
          <Empty size="lg">
            <EmptyHeader>
              <EmptyMedia icon={UserSparklesIcon} />
              <EmptyTitle>{t`No agents yet`}</EmptyTitle>
              {/* Only who can make one is told what to do. */}
              {emptyLine === undefined ? null : (
                <EmptyDescription>{emptyLine}</EmptyDescription>
              )}
            </EmptyHeader>
            {newAgent === undefined ? null : (
              <EmptyContent>{newAgent}</EmptyContent>
            )}
          </Empty>
        ) : null}
        {!none && managed !== undefined ? (
          <AgentTabs
            agents={agents}
            company={company}
            facts={facts}
            mine={mine}
            onTab={onTab}
            tab={tab}
          />
        ) : null}
        {!none && managed === undefined ? (
          <AgentGroups agents={agents} facts={facts} mine={mine} />
        ) : null}
        {/* Without tabs, what an admin keeps of the company stands under the cards. */}
        {none || managed === undefined ? company : null}
      </div>
    </AppShellPage>
  );
};
