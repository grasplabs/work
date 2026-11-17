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
import { AgentMark } from "../grasp/agent-mark/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { AgentPerson, Conversation, Search } from "../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupClear,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { Link as TextLink } from "../grasp/link/index.ts";
import { SectionHeader } from "../grasp/section-header/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Toggle, ToggleGroup } from "../grasp/toggle/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { dollars } from "../settings/money.ts";
import { classesOn, useAudienceLine, wakesOn } from "./agent-facts.tsx";
import { NewAgentButton } from "./new-agent.tsx";

// The Agents page: the company's agents, a row each, on Grasp UI's Item.
// Everyone sees the agents they may talk to (`chats.agents`), each with
// Chat, which starts a chat with it. The company's admins see every
// agent (`connections.agents`), each row with whom it answers, how much
// it may do, whether it works on its own and what it cost this month;
// its name opens the agent's page (agent-page.tsx). New agent asks for
// one in a dialog (new-agent.tsx).

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
  tools: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space3,
  },
  search: { width: "100%", maxWidth: "18rem" },
  lines: { display: "grid", gap: grasp.space1 },
  groups: { display: "grid", gap: grasp.space8 },
  groupHead: { marginBlockEnd: grasp.space2 },
});

/** What a row shows of one agent. */
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
        usage: AgentUsage | undefined;
      }
    | undefined;
}

/**
 * What an admin's row says of an agent under its job, a few words each:
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

/** The rows: every agent for an admin, else the ones the person may talk to. */
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

/** Which agents an admin's list shows. */
const filters = ["all", "on", "paused"] as const;
type Filter = (typeof filters)[number];

/**
 * One agent's row: its name leads an admin to its page, and Chat, where
 * it answers the person and is on, starts a chat with it. Grasp UI's
 * Item links a whole row only by a plain `href`, which the router
 * wouldn't follow and which takes no Chat beside it, so the name is the
 * link.
 */
const AgentRow = ({
  shown,
  facts,
}: {
  shown: Shown;
  facts: readonly string[];
}) => {
  const { t } = useLingui();
  const { managed } = shown;
  const job = shown.job === "" ? t`No job written yet` : shown.job;
  const answers = managed === undefined || managed.state === "on";
  return (
    <Item>
      <ItemMedia>
        <AgentMark name={shown.name} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {managed === undefined ? (
            shown.name
          ) : (
            <TextLink
              render={<Link params={{ agent: shown.id }} to="/agents/$agent" />}
            >
              {shown.name}
            </TextLink>
          )}
          {managed?.state === "paused" ? (
            <ItemDetail>{t`Paused`}</ItemDetail>
          ) : null}
        </ItemTitle>
        <ItemDescription>
          {facts.length === 0 ? (
            job
          ) : (
            <span {...stylex.props(styles.lines)}>
              <span>{job}</span>
              <Text element="span" size="xs" tone="quiet">
                {facts.join(" · ")}
              </Text>
            </span>
          )}
        </ItemDescription>
      </ItemContent>
      {shown.usable && answers ? (
        <ItemActions>
          <Button
            icon={Conversation}
            render={<Link search={{ agent: shown.id }} to="/" />}
            size="sm"
          >
            {t`Chat`}
          </Button>
        </ItemActions>
      ) : null}
    </Item>
  );
};

/** One group of the list: its name, and the agents in it. */
interface AgentGroup {
  key: string;
  name: string;
  agents: readonly Shown[];
}

/**
 * The list's groups, in order: the person's own agents ("Yours"), the
 * company's, and a colleague's own put forward for the whole company
 * ("Waiting for approval", each row with Approve and Decline). A group
 * shows only while it holds an agent, and its name only beside another
 * group: alone, the page's title says it. This branch's core has only
 * the company's agents, the first agent first; the other two join as one
 * entry each once core names them (main's `ownAgents`, `offeredAgents`).
 */
const AgentGroups = ({
  groups,
  factsOf,
}: {
  groups: readonly AgentGroup[];
  factsOf: (managed: NonNullable<Shown["managed"]>) => string[];
}) => {
  const { t } = useLingui();
  const held = groups.filter(({ agents }) => agents.length > 0);
  const named = held.length > 1;
  return (
    <div {...stylex.props(styles.groups)}>
      {held.map((group) => (
        <section key={group.key}>
          {named ? (
            <SectionHeader
              layout={styles.groupHead}
              size="sm"
              title={group.name}
            />
          ) : null}
          <ItemGroup aria-label={named ? group.name : t`Agents`} separated>
            {group.agents.map((agent) => (
              <AgentRow
                facts={
                  agent.managed === undefined ? [] : factsOf(agent.managed)
                }
                key={agent.id}
                shown={agent}
              />
            ))}
          </ItemGroup>
        </section>
      ))}
    </div>
  );
};

/** The Agents page's body: the agents the person may `usable`, and what an admin `managed`. */
export const AgentsOverview = ({
  usable,
  managed,
  makes,
  models,
}: {
  usable: readonly ChatAgent[];
  managed: ManagedAgents | undefined;
  /** Whether the person may make an agent: the company's own admins. */
  makes: boolean;
  /** The models a new agent can be given. */
  models: readonly string[];
}) => {
  const { t } = useLingui();
  const factsOf = useFacts(managed?.teams ?? []);
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
  const newAgent = makes ? <NewAgentButton models={models} /> : undefined;
  return (
    <Page>
      <PageHeading action={newAgent} title={t`Agents`} />
      {agents.length === 0 ? (
        <Empty size="page">
          <EmptyHeader>
            <EmptyMedia icon={AgentPerson} />
            <EmptyTitle>{t`No agents yet`}</EmptyTitle>
            <EmptyDescription>
              {managed === undefined
                ? t`The agents your company sets up for you show here.`
                : t`Make one for a job, such as chasing unpaid invoices.`}
            </EmptyDescription>
          </EmptyHeader>
          {newAgent === undefined ? null : (
            <EmptyContent>{newAgent}</EmptyContent>
          )}
        </Empty>
      ) : (
        <>
          {/* Search only once there are enough to look for one. */}
          {agents.length < 6 && paused === 0 ? null : (
            <div {...stylex.props(styles.tools)}>
              <InputGroup layout={styles.search}>
                <InputGroupText icon={Search} />
                <InputGroupInput
                  aria-label={t`Search the agents`}
                  onValueChange={setQuery}
                  placeholder={t`Search`}
                  type="search"
                  value={query}
                />
                <InputGroupClear aria-label={t`Clear search`} />
              </InputGroup>
              {/* Only where some are paused: with all on there is nothing to tell apart. */}
              {managed === undefined || paused === 0 ? null : (
                <ToggleGroup
                  aria-label={t`Which agents to show`}
                  onValueChange={(next: unknown[]) => {
                    setFilter(
                      filters.find((each) => each === next.at(0)) ?? "all"
                    );
                  }}
                  size="sm"
                  value={[filter]}
                >
                  <Toggle value="all">{t`All`}</Toggle>
                  <Toggle value="on">{t`On`}</Toggle>
                  <Toggle value="paused">{t`Paused`}</Toggle>
                </ToggleGroup>
              )}
            </div>
          )}
          {shown.length === 0 ? (
            <Empty size="section">
              {asked === ""
                ? t`No agent to show here`
                : t`No agent matches “${asked}”`}
            </Empty>
          ) : (
            <AgentGroups
              factsOf={factsOf}
              groups={[{ key: "company", name: t`Company`, agents: shown }]}
            />
          )}
        </>
      )}
    </Page>
  );
};
