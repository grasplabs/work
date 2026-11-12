import type { Agent, AgentSettings, AgentWake } from "@grasp-os/shared/agents";
import type { Member } from "@grasp-os/shared/members";
import type { StephenReach } from "@grasp-os/shared/stephen-reach";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import { Card } from "@grasp-os/ui/components/card";
import { Switch } from "@grasp-os/ui/components/switch";
import {
  Tabs,
  TabsContent,
  TabsCount,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useRouter } from "@tanstack/react-router";
import { MessageCircleIcon } from "lucide-react";
import { useId } from "react";
import type { ReactNode } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SettingsSection } from "../settings/settings-parts.tsx";
import {
  AudienceControl,
  appAudienceOf,
  audienceOf,
  chosenOf,
} from "../settings/stephen-audience.tsx";
import { StephenAvatar } from "../settings/stephen-avatar.tsx";
import { classNames, Row } from "../settings/stephen-settings.tsx";
import { useCoreAction } from "../use-core-action.ts";
import {
  AgentStateBadge,
  classesOn,
  nextWakeAt,
  useAudienceLine,
  wakesOn,
} from "./agent-facts.tsx";
import { AgentForm } from "./agent-form.tsx";
import { AgentWakes } from "./agent-wakes.tsx";

// One agent's page, for the company's admins: what it is, what it is
// told, whom it answers and what it may do, and when it works on its own,
// each on a tab. Its heading has the two things done most: a chat with
// it, and turning it off and on. The first agent is the one every company
// starts with; whom it reaches and what it may do stays in Settings ›
// Stephen, and its Access tab leads there. Every other agent starts
// reaching nobody and with nothing it may do. Each layer only narrows the
// one above it: an agent has a class of tools for at most the people the
// company has it for. Core keeps it all and holds every agent to it from
// the next message (agent-builder.ts, agent-reach.ts, agent-wakes.ts).
// Every control saves at once and reads the page again.

/** What a page change asks of core, then the page read again. */
type Change = (action: (session: Session) => Promise<unknown>) => Promise<void>;

/** An agent's tabs, by the names its address carries. */
export const agentTabs = [
  "overview",
  "instructions",
  "access",
  "schedule",
] as const;
export type AgentTab = (typeof agentTabs)[number];

/** The tab an address names; Overview for any other. */
export const agentTabOf = (value: unknown): AgentTab =>
  agentTabs.find((tab) => tab === value) ?? "overview";

/** One fact at the head of the overview: what it is, and what holds now. */
const Glance = ({
  label,
  value,
  line,
}: {
  label: string;
  value: ReactNode;
  line?: ReactNode;
}) => (
  <div className="bg-card flex min-w-0 flex-col gap-1 rounded-xl border p-4">
    <dt className="text-muted-foreground text-xs">{label}</dt>
    <dd className="truncate font-medium">{value}</dd>
    {line === undefined ? null : (
      <dd className="text-muted-foreground truncate text-xs">{line}</dd>
    )}
  </div>
);

/** A date and time as people read it here. */
const useMoment = () => {
  const { i18n } = useLingui();
  return (iso: string): string =>
    new Intl.DateTimeFormat(i18n.locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
};

/** The agent at a glance: whether it answers, whom, how much it may do, and when it works on its own. */
const Glances = ({
  agent,
  first,
  settings,
  teams,
  wakes,
}: {
  agent: Agent;
  first: boolean;
  settings: AgentSettings | undefined;
  teams: StephenReach["teams"];
  wakes: readonly AgentWake[];
}) => {
  const { t } = useLingui();
  const audienceLine = useAudienceLine(teams);
  const moment = useMoment();
  const classes = settings === undefined ? undefined : classesOn(settings);
  const scheduled = wakesOn(wakes).length;
  const next = nextWakeAt(wakes);
  return (
    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Glance
        label={t`Status`}
        line={
          agent.state === "on"
            ? t`Answers the people it is for`
            : t`Answers nobody anywhere`
        }
        value={agent.state === "on" ? t`On` : t`Paused`}
      />
      <Glance
        label={t`Who may use it`}
        line={
          first || settings === undefined
            ? t`As the company's first agent`
            : undefined
        }
        value={
          first || settings === undefined
            ? t`Set in Settings › Stephen`
            : audienceLine(settings.audience)
        }
      />
      <Glance
        label={t`What it may do`}
        line={
          classes === undefined
            ? t`As the company's first agent`
            : t`Kinds of work the company has turned on`
        }
        value={
          classes === undefined
            ? t`Set in Settings › Stephen`
            : t`${classes.on} of ${classes.of}`
        }
      />
      <Glance
        label={t`Works on its own`}
        line={next === undefined ? undefined : t`Next: ${moment(next)}`}
        value={
          scheduled === 0 ? t`Only when asked` : t`${scheduled} on a schedule`
        }
      />
    </dl>
  );
};

/** Whom an agent answers and what it may do, or where that is set for the first agent. */
const Access = ({
  agent,
  first,
  settings,
  teams,
  can,
  change,
}: {
  agent: Agent;
  first: boolean;
  settings: AgentSettings | undefined;
  teams: StephenReach["teams"];
  can: boolean;
  change: Change;
}) => {
  const { t, i18n } = useLingui();
  const { name } = agent;
  if (first || settings === undefined) {
    return (
      <SettingsSection
        action={
          <Button
            // A link, drawn as a button.
            nativeButton={false}
            render={<Link to="/settings/stephen" />}
            size="sm"
            variant="outline"
          >
            <Trans>Open Settings › Stephen</Trans>
          </Button>
        }
        description={t`Whom the company's first agent reaches, where, and what it may do in each app is set in one place.`}
        title={t`Who may use it, and what it may do`}
      />
    );
  }
  return (
    <>
      <SettingsSection
        description={t`People outside it can't ask it anything, in Grasp or in a chat app.`}
        title={t`Who may use it`}
      >
        <ul>
          <Row
            description={
              settings.audience.who === "nobody"
                ? t`Nobody yet, until you choose.`
                : undefined
            }
            name={t`${name} answers`}
          >
            <AudienceControl
              editable={can}
              key={JSON.stringify(settings.audience)}
              label={t`Who may use ${name}`}
              offers={["everyone", "teams", "nobody"]}
              teams={teams}
              value={chosenOf(settings.audience)}
              onSave={async (chosen) => {
                await change(async (session) => {
                  await session.connections.setAgentReach(
                    agent.id,
                    settings.on,
                    audienceOf(chosen)
                  );
                });
              }}
            />
          </Row>
        </ul>
      </SettingsSection>
      <SettingsSection
        description={t`Each kind of work as the company has it, or for fewer people. Never for more.`}
        title={t`What it may do`}
      >
        <ul>
          {settings.classes.map(({ toolClass, audience }) => {
            const className = i18n._(classNames[toolClass]);
            return (
              <Row key={toolClass} name={className}>
                <AudienceControl
                  editable={can}
                  key={JSON.stringify(audience)}
                  label={t`${className}, for ${name}`}
                  offers={["same", "teams", "nobody"]}
                  same={t`As the company has it`}
                  teams={teams}
                  value={chosenOf(audience)}
                  onSave={async (chosen) => {
                    await change(async (session) => {
                      await session.connections.setAgentToolClass(
                        agent.id,
                        toolClass,
                        appAudienceOf(chosen)
                      );
                    });
                  }}
                />
              </Row>
            );
          })}
        </ul>
      </SettingsSection>
    </>
  );
};

/** One agent's page body. */
export const AgentPage = ({
  agent,
  first,
  settings,
  teams,
  wakes,
  people,
  editable,
  usable,
  tab,
  onTab,
}: {
  agent: Agent;
  /** The company's first agent, whose reach is Settings › Stephen's. */
  first: boolean;
  settings: AgentSettings | undefined;
  teams: StephenReach["teams"];
  wakes: readonly AgentWake[];
  /** The company's people, whom a wake-up can work for. */
  people: readonly Member[];
  /** Whether the person may change agents at all. */
  editable: boolean;
  /** Whether the person may talk to it themselves. */
  usable: boolean;
  tab: AgentTab;
  onTab: (tab: AgentTab) => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const switchId = useId();
  const moment = useMoment();
  const { busy, failure, run } = useCoreAction();
  const change: Change = async (action) => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await action(session);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  const can = editable && !busy;
  const { name } = agent;
  const on = agent.state === "on";
  const typed = {
    name: agent.name,
    job: agent.job,
    instructions: agent.instructions,
  };
  const save = async (next: typeof typed): Promise<void> => {
    await change(async (session) => {
      await session.connections.changeAgent(agent.id, {
        ...next,
        face: agent.face,
        modelRole: agent.modelRole,
      });
    });
  };
  const scheduled = wakesOn(wakes).length;
  return (
    <Page>
      <PageHeading
        action={
          <div className="flex flex-wrap items-center gap-4">
            <label
              className="flex items-center gap-2 text-sm"
              htmlFor={switchId}
            >
              <Switch
                checked={on}
                disabled={!can}
                id={switchId}
                onCheckedChange={(next) => {
                  void change(async (session) => {
                    await session.connections.setAgentPaused(agent.id, !next);
                  });
                }}
              />
              {on ? t`${name} is on` : t`${name} is paused`}
            </label>
            {usable && on ? (
              <Link
                className={buttonVariants()}
                search={{ agent: agent.id }}
                to="/"
              >
                <MessageCircleIcon data-icon="inline-start" />
                <Trans>Chat with {name}</Trans>
              </Link>
            ) : null}
          </div>
        }
        clamp
        description={agent.job === "" ? t`No job written yet` : agent.job}
        meta={
          <>
            <AgentStateBadge state={agent.state} />
            {first ? (
              <span className="text-muted-foreground text-xs">
                {t`The company's first agent`}
              </span>
            ) : null}
          </>
        }
        title={
          <span className="flex items-center gap-3">
            <StephenAvatar />
            {name}
          </span>
        }
      />
      <ErrorText>{failure}</ErrorText>
      <Tabs
        onValueChange={(next: unknown) => {
          onTab(agentTabOf(next));
        }}
        value={tab}
      >
        <TabsList>
          <TabsTrigger value="overview">
            <Trans>Overview</Trans>
          </TabsTrigger>
          <TabsTrigger value="instructions">
            <Trans>Instructions</Trans>
          </TabsTrigger>
          <TabsTrigger value="access">
            <Trans>Access</Trans>
          </TabsTrigger>
          <TabsTrigger value="schedule">
            <Trans>Schedule</Trans>
            {scheduled === 0 ? null : (
              <TabsCount label={t`${scheduled} on a schedule`}>
                {scheduled}
              </TabsCount>
            )}
          </TabsTrigger>
        </TabsList>
        <TabsContent keepMounted value="overview">
          <div className="flex flex-col gap-6">
            <Glances
              agent={agent}
              first={first}
              settings={settings}
              teams={teams}
              wakes={wakes}
            />
            <SettingsSection
              description={t`What people call it, and one line on what it is for. Both show where people pick an agent.`}
              title={t`Name and job`}
            >
              <AgentForm
                can={can}
                initial={typed}
                // By what core keeps: what is typed and not yet saved stays
                // while the agent is paused or its reach changes.
                key={`${agent.id}:${agent.name}:${agent.job}`}
                onSave={save}
                parts={["name", "job"]}
                submit={t`Save`}
              />
            </SettingsSection>
            {agent.changedAt === null ? null : (
              <p className="text-muted-foreground text-xs">
                <Trans>Last changed {moment(agent.changedAt)}</Trans>
              </p>
            )}
          </div>
        </TabsContent>
        <TabsContent keepMounted value="instructions">
          <div className="flex flex-col gap-6">
            <SettingsSection
              description={t`What ${name} should know and how it should work, on top of Grasp's own rules. Those always hold over what is written here.`}
              title={t`Instructions`}
            >
              <AgentForm
                can={can}
                initial={typed}
                key={`${agent.id}:${agent.instructions}`}
                onSave={save}
                parts={["instructions"]}
                submit={t`Save`}
              />
            </SettingsSection>
          </div>
        </TabsContent>
        <TabsContent keepMounted value="access">
          <div className="flex flex-col gap-6">
            <Access
              agent={agent}
              can={can}
              change={change}
              first={first}
              settings={settings}
              teams={teams}
            />
          </div>
        </TabsContent>
        <TabsContent keepMounted value="schedule">
          <div className="flex flex-col gap-6">
            <Card variant="panel">
              <ul className="[&>li:first-child]:border-t-0">
                <AgentWakes
                  agent={agent}
                  can={can}
                  change={change}
                  editable={editable}
                  people={people}
                  wakes={wakes}
                />
              </ul>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </Page>
  );
};
