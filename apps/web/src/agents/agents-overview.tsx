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
import { Link, useRouter } from "@tanstack/react-router";
import type { MouseEvent, ReactNode } from "react";
import { useState } from "react";

import { Page, PageHeading } from "../frame/page.tsx";
import { Button } from "../grasp/button/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import { AgentPerson, Conversation, Search } from "../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupClear,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import { Item, ItemGroup } from "../grasp/item/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Toggle, ToggleGroup } from "../grasp/toggle/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { dollars } from "../settings/money.ts";
import { AgentAvatar } from "./agent-avatar.tsx";
import { classesOn, useAudienceLine, wakesOn } from "./agent-facts.tsx";
import { NewAgentButton } from "./new-agent.tsx";

// The Agents page: the company's agents, a row each, on Grasp UI's Item.
// Everyone sees the agents they may talk to (`chats.agents`), each with
// Chat, which starts a chat with it. The company's admins see every
// agent (`connections.agents`), each row with whom it answers, how much
// it may do, whether it works on its own and what it cost this month;
// the row opens the agent's page (agent-page.tsx). New agent asks for
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

/**
 * Rows whose `href` the router follows. Grasp UI's Item draws a linked
 * row as a plain `<a href>`, with no way to hand it the router's link,
 * so a plain press on one is taken here and followed in the page, as a
 * router link would; a press with a key held (a new tab) is the
 * browser's.
 */
const RouterRows = ({ children }: { children: ReactNode }) => {
  const router = useRouter();
  const follow = (event: MouseEvent<HTMLDivElement>) => {
    const { target } = event;
    const anchor = target instanceof Element ? target.closest("a[href]") : null;
    const plainPress =
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey;
    if (!(anchor instanceof HTMLAnchorElement && plainPress)) {
      return;
    }
    const href = anchor.getAttribute("href") ?? "";
    if (href.startsWith("/")) {
      event.preventDefault();
      void router.navigate({ href });
    }
  };
  // A press on a link inside: the links themselves take the keys.
  // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- only follows its links' own presses
  return <div onClick={follow}>{children}</div>;
};

/** Which agents an admin's list shows. */
const filters = ["all", "on", "paused"] as const;
type Filter = (typeof filters)[number];

/** One agent's row: an admin's opens its page; anyone else's has Chat. */
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
  const description =
    facts.length === 0 ? (
      job
    ) : (
      <span {...stylex.props(styles.lines)}>
        <span>{job}</span>
        <Text element="span" size="xs" tone="quiet">
          {facts.join(" · ")}
        </Text>
      </span>
    );
  const media = <AgentAvatar face={shown.face} size="sm" />;
  const detail = managed?.state === "paused" ? t`Paused` : undefined;
  if (managed !== undefined) {
    return (
      <Item
        description={description}
        detail={detail}
        href={`/agents/${encodeURIComponent(shown.id)}`}
        media={media}
        title={shown.name}
      />
    );
  }
  return (
    <Item
      actions={
        <Button
          icon={Conversation}
          render={<Link search={{ agent: shown.id }} to="/" />}
          size="sm"
        >
          {t`Chat`}
        </Button>
      }
      description={description}
      media={media}
      title={shown.name}
    />
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
        <Empty
          action={newAgent}
          icon={AgentPerson}
          size="page"
          title={t`No agents yet`}
        >
          {managed === undefined
            ? t`The agents your company sets up for you show here.`
            : t`Make one for a job, such as chasing unpaid invoices.`}
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
                <InputGroupClear label={t`Clear search`} />
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
            <RouterRows>
              <ItemGroup aria-label={t`Agents`} separated>
                {shown.map((agent) => (
                  <AgentRow
                    facts={
                      agent.managed === undefined ? [] : factsOf(agent.managed)
                    }
                    key={agent.id}
                    shown={agent}
                  />
                ))}
              </ItemGroup>
            </RouterRows>
          )}
        </>
      )}
    </Page>
  );
};
