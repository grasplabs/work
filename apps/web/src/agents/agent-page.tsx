import type {
  Agent,
  AgentSettings,
  AgentUsage,
  AgentWake,
} from "@grasp-os/shared/agents";
import type { Member } from "@grasp-os/shared/members";
import type { StephenReach } from "@grasp-os/shared/stephen-reach";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
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
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { MessageCircleIcon, TrashIcon } from "lucide-react";
import { useId } from "react";
import type { ReactNode } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { Page, PageHeading, SectionTitle } from "../frame/page.tsx";
import { dollars } from "../settings/money.ts";
import { SettingsSection } from "../settings/settings-parts.tsx";
import {
  AudienceControl,
  appAudienceOf,
  audienceOf,
  chosenOf,
} from "../settings/stephen-audience.tsx";
import { classNames, Row } from "../settings/stephen-settings.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { AgentAvatar } from "./agent-avatar.tsx";
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

/** A month such as `2026-11`, as people read it: November 2026. */
const useMonthName = () => {
  const { i18n } = useLingui();
  return (month: string): string => {
    const [year = 0, of = 1] = month.split("-").map(Number);
    return new Intl.DateTimeFormat(i18n.locale, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, of - 1, 1)));
  };
};

/**
 * What the agent used of the organization's models this month: what it
 * cost, how often a model was asked, for how many people, and when last.
 * How much, never what: core says no more (agent-usage.ts).
 */
const Usage = ({ usage }: { usage: AgentUsage }) => {
  const { t } = useLingui();
  const moment = useMoment();
  const monthName = useMonthName();
  const before = dollars(usage.spentBefore);
  const { requests, people } = usage;
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>{monthName(usage.month)}</SectionTitle>
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Glance
          label={t`Cost`}
          line={t`${before} the month before`}
          value={dollars(usage.spent)}
        />
        <Glance
          label={t`Requests to a model`}
          line={t`Several for one question`}
          value={String(requests)}
        />
        <Glance
          label={t`People it worked for`}
          line={t`Asked it, or it works for them on a schedule`}
          value={String(people)}
        />
        <Glance
          label={t`Last asked`}
          value={usage.lastAt === null ? t`Not yet` : moment(usage.lastAt)}
        />
      </dl>
    </section>
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
  usage,
  models,
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
  /** What it used of the models this month; none where core didn't say. */
  usage: AgentUsage | undefined;
  /** The models the organization chose, which an agent can be given. */
  models: readonly string[];
  tab: AgentTab;
  onTab: (tab: AgentTab) => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const navigate = useNavigate();
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
    face: agent.face,
    model: agent.model,
  };
  // What a card says, over the agent as core has it now: a card saves its
  // own parts and never what another card saved since it was shown.
  const save = async (said: Partial<typeof typed>): Promise<void> => {
    await change(async (session) => {
      await session.connections.changeAgent(agent.id, {
        ...typed,
        ...said,
        modelRole: agent.modelRole,
      });
    });
  };
  const remove = async (): Promise<void> => {
    const done = await run(async (session) => {
      await session.connections.deleteAgent(agent.id);
      return true;
    });
    if (done === true) {
      await navigate({ to: "/agents", replace: true });
    }
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
            <AgentAvatar face={agent.face} />
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
            {usage === undefined ? null : <Usage usage={usage} />}
            <SettingsSection
              description={t`What people call it, one line on what it is for, and its picture. All three show where people pick an agent.`}
              title={t`Name, job and picture`}
            >
              <AgentForm
                can={can}
                initial={typed}
                // By what core keeps: what is typed and not yet saved stays
                // while the agent is paused or its reach changes.
                key={`${agent.id}:${agent.name}:${agent.job}:${agent.face}`}
                onSave={save}
                parts={["name", "job", "face"]}
                submit={t`Save`}
              />
            </SettingsSection>
            <SettingsSection
              description={t`Which model answers when ${name} is asked.`}
              title={t`Model`}
            >
              <AgentForm
                can={can}
                initial={typed}
                key={`${agent.id}:${agent.model ?? ""}`}
                models={models}
                onSave={save}
                parts={["model"]}
                submit={t`Save`}
              />
            </SettingsSection>
            {first ? null : (
              <SettingsSection
                action={
                  <AlertDialog>
                    <AlertDialogTrigger
                      disabled={!can}
                      render={<Button size="sm" variant="destructive" />}
                    >
                      <TrashIcon data-icon="inline-start" />
                      <Trans>Delete</Trans>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          <Trans>Delete {name}?</Trans>
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          <Trans>
                            It is gone for good: it answers nobody, and its
                            schedule and settings are removed. The chats people
                            had with it stay theirs to read.
                          </Trans>
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>
                          <Trans>Cancel</Trans>
                        </AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => {
                            void remove();
                          }}
                          variant="destructive"
                        >
                          <Trans>Delete for good</Trans>
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                }
                description={t`For good. To stop it answering for a while, turn it off instead.`}
                title={t`Delete ${name}`}
              />
            )}
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
