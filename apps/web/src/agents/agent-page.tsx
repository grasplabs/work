import type {
  Agent,
  AgentDocument,
  AgentSettings,
  AgentUsage,
  AgentWake,
} from "@grasp-os/shared/agents";
import type { ToolClassSetting } from "@grasp-os/shared/connect";
import type { Member } from "@grasp-os/shared/members";
import type { StephenReach } from "@grasp-os/shared/stephen-reach";
import type { StephenWeek } from "@grasp-os/shared/stephen-requests";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { modelName } from "../chat/model-names.tsx";
import type { Session } from "../core.ts";
import { Page } from "../frame/page.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogPanel,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogFooter,
  DialogPanel,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import {
  Agent as AgentIcon,
  CalendarIcon,
  Clock,
  Conversation,
  Edit,
  Money,
  People,
  Tool,
  Trash,
} from "../grasp/icons/index.ts";
import { Item, ItemGroup } from "../grasp/item/index.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import type { KeyValueItem } from "../grasp/key-value/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Switch } from "../grasp/switch/index.ts";
import { TabsLink, TabsNav } from "../grasp/tabs/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { dollars } from "../settings/money.ts";
import { SettingRow, SettingsRows } from "../settings/section.tsx";
import {
  AudienceControl,
  appAudienceOf,
  audienceOf,
  chosenOf,
} from "../settings/stephen-audience.tsx";
import { classNames, StephenSettings } from "../settings/stephen-settings.tsx";
import type { AskableWorkflow } from "../settings/stephen-settings.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { AgentAvatar } from "./agent-avatar.tsx";
import { AgentDocuments } from "./agent-documents.tsx";
import {
  AgentFailure,
  AgentStateBadge,
  classesOn,
  nextWakeAt,
  useAudienceLine,
  wakesOn,
} from "./agent-facts.tsx";
import { AgentForm } from "./agent-form.tsx";
import type { Part, Typed } from "./agent-form.tsx";
import { AgentWakes } from "./agent-wakes.tsx";

// One agent's page, for the company's admins, on Grasp UI: its Page
// header holds the agent (picture, name, what it is for, whether it is
// on) and the things done most: turning it off and on, Chat, and Edit,
// which changes its name, job, picture and model in a dialog. Its views
// are tab links in the header, the tab in the address so a link can lead
// to an agent's access or its schedule:
//
// - Overview: its facts as a rail (whom it answers, what it may do, when
//   it works on its own, its model, this month's use) and what it did
//   lately (its scheduled runs, and when it was last asked); Delete.
// - Instructions: what it is told, and the documents it answers from.
// - Access: whom it answers and what it may do, each kind of work a row.
//   The first agent's is the company's own, Settings › Stephen's whole.
// - Schedule: when it works on its own (agent-wakes.tsx).
//
// Each layer only narrows the one above it: an agent has a class of
// tools for at most the people the company has it for. Core keeps it all
// and holds every agent to it from the next message (agent-builder.ts,
// agent-reach.ts, agent-wakes.ts). Every control saves at once and reads
// the page again.

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

const styles = stylex.create({
  title: { display: "flex", alignItems: "center", gap: grasp.space3 },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space3,
  },
  stack: { display: "grid", gap: grasp.space6 },
});

/** A date and time as people read it here. */
const useMoment = () => {
  const { i18n } = useLingui();
  return (iso: string): string =>
    new Intl.DateTimeFormat(i18n.locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
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
 * Whom an agent answers and how much it may do, in a few words. The
 * first agent's is the company's own, set under Access. Another agent's
 * that core didn't say (as it won't for Grasp's staff) is said to be not
 * shown, never passed off as anyone's.
 */
const useAccessWords = (
  first: boolean,
  settings: AgentSettings | undefined,
  teams: StephenReach["teams"]
): { who: string; may: string } => {
  const { t } = useLingui();
  const audienceLine = useAudienceLine(teams);
  if (first) {
    return { who: t`Everyone with Grasp`, may: t`Set for each app` };
  }
  if (settings === undefined) {
    return { who: t`Not shown`, may: t`Not shown` };
  }
  const classes = classesOn(settings);
  return {
    who: audienceLine(settings.audience),
    may:
      classes.on === 0
        ? t`Nothing yet`
        : t`${classes.on} of ${classes.of} kinds of work`,
  };
};

/** The agent's facts, as a rail: one row each, this month's use opening to say more. */
const Facts = ({
  agent,
  first,
  settings,
  teams,
  wakes,
  usage,
}: {
  agent: Agent;
  first: boolean;
  settings: AgentSettings | undefined;
  teams: StephenReach["teams"];
  wakes: readonly AgentWake[];
  usage: AgentUsage | undefined;
}) => {
  const { t } = useLingui();
  const moment = useMoment();
  const monthName = useMonthName();
  const { who, may } = useAccessWords(first, settings, teams);
  const scheduled = wakesOn(wakes).length;
  const next = nextWakeAt(wakes);
  const nextMoment = next === undefined ? "" : moment(next);
  const items: KeyValueItem[] = [
    { key: t`Answers`, value: who, icon: People },
    { key: t`May do`, value: may, icon: Tool },
    {
      key: t`On its own`,
      value:
        scheduled === 0
          ? t`Only when asked`
          : t`${scheduled} on a schedule, next ${nextMoment}`,
      icon: CalendarIcon,
    },
    {
      key: t`Model`,
      value: agent.model === null ? t`The asker's` : modelName(agent.model),
      icon: AgentIcon,
    },
  ];
  if (usage !== undefined) {
    const before = dollars(usage.spentBefore);
    const { requests, people } = usage;
    items.push({
      key: monthName(usage.month),
      value: dollars(usage.spent),
      icon: Money,
      detail: [
        plural(requests, {
          one: "# request to a model",
          other: "# requests to a model",
        }),
        plural(people, { one: "for # person", other: "for # people" }),
        t`${before} the month before`,
      ].join(" · "),
    });
  }
  if (agent.changedAt !== null) {
    items.push({
      key: t`Changed`,
      value: moment(agent.changedAt),
      icon: Clock,
    });
  }
  return <KeyValueList divided items={items} layout="inline" />;
};

/**
 * What the agent did lately: each schedule's last run and how it went,
 * and when someone last asked it. Core keeps no more of its runs for
 * this page (agent-wakes.ts, agent-usage.ts).
 */
const RecentActivity = ({
  wakes,
  usage,
}: {
  wakes: readonly AgentWake[];
  usage: AgentUsage | undefined;
}) => {
  const { t } = useLingui();
  const moment = useMoment();
  const ran = wakes
    .flatMap((wake) =>
      wake.lastAt === null ? [] : [{ ...wake, lastAt: wake.lastAt }]
    )
    .toSorted((a, b) => b.lastAt.localeCompare(a.lastAt));
  const asked = usage?.lastAt ?? null;
  return (
    <SectionCard flush title={t`Recent activity`}>
      {ran.length === 0 && asked === null ? (
        <Empty size="inline">{t`Nothing yet. What it does shows here.`}</Empty>
      ) : (
        <ItemGroup separated>
          {asked === null ? null : (
            <Item
              description={moment(asked)}
              icon={Conversation}
              iconLook="inline"
              size="sm"
              title={t`Last asked in a chat`}
            />
          )}
          {ran.map((wake) => (
            <Item
              description={
                wake.lastOutcome === null
                  ? moment(wake.lastAt)
                  : `${moment(wake.lastAt)} · ${wake.lastOutcome}`
              }
              icon={CalendarIcon}
              iconLook="inline"
              key={wake.id}
              size="sm"
              title={wake.opening}
            />
          ))}
        </ItemGroup>
      )}
    </SectionCard>
  );
};

/** What the first agent's access is read from, as Settings › Stephen read it. */
export interface FirstAgentAccess {
  reach: StephenReach;
  classes: ToolClassSetting[];
  week: StephenWeek | null;
  workflows: AskableWorkflow[] | null;
}

/** Whom an agent but the first answers and what it may do, a row each. */
const Access = ({
  agent,
  settings,
  teams,
  can,
  change,
}: {
  agent: Agent;
  settings: AgentSettings | undefined;
  teams: StephenReach["teams"];
  can: boolean;
  change: Change;
}) => {
  const { t, i18n } = useLingui();
  const { name } = agent;
  if (settings === undefined) {
    // Core didn't say, as it won't for Grasp's staff: said, never left
    // blank or shown as anyone's.
    return (
      <Empty kind="error" size="section" title={t`Access isn't shown`}>
        {t`Only the company's own admins see it. If that is you, load the page again.`}
      </Empty>
    );
  }
  return (
    <>
      <SectionCard flush title={t`Who may use it`}>
        <SettingsRows>
          <SettingRow
            help={t`Nobody outside it can ask it anything, in Grasp or a chat app.`}
            label={t`${name} answers`}
          >
            {() => (
              <AudienceControl
                editable={can}
                key={JSON.stringify(settings.audience)}
                label={t`Who may use ${name}`}
                offers={["everyone", "teams", "nobody"]}
                onSave={async (chosen) => {
                  await change(async (session) => {
                    await session.connections.setAgentReach(
                      agent.id,
                      settings.on,
                      audienceOf(chosen)
                    );
                  });
                }}
                teams={teams}
                value={chosenOf(settings.audience)}
              />
            )}
          </SettingRow>
        </SettingsRows>
      </SectionCard>
      <SectionCard
        description={t`Each as the company has it, or for fewer people. Never more.`}
        flush
        title={t`What it may do`}
      >
        <SettingsRows>
          {settings.classes.map(({ toolClass, audience }) => {
            const className = i18n._(classNames[toolClass]);
            return (
              <SettingRow key={toolClass} label={className}>
                {() => (
                  <AudienceControl
                    editable={can}
                    key={JSON.stringify(audience)}
                    label={t`${className}, for ${name}`}
                    offers={["same", "teams", "nobody"]}
                    onSave={async (chosen) => {
                      await change(async (session) => {
                        await session.connections.setAgentToolClass(
                          agent.id,
                          toolClass,
                          appAudienceOf(chosen)
                        );
                      });
                    }}
                    same={t`As the company has it`}
                    teams={teams}
                    value={chosenOf(audience)}
                  />
                )}
              </SettingRow>
            );
          })}
        </SettingsRows>
      </SectionCard>
    </>
  );
};

/** Edit: the agent's name, job, picture and model, in a dialog. */
const EditAgent = ({
  agent,
  typed,
  models,
  can,
  save,
}: {
  agent: Agent;
  typed: Typed;
  models: readonly string[];
  can: boolean;
  save: (said: Partial<Typed>) => Promise<boolean>;
}) => {
  const { t } = useLingui();
  const formId = useId();
  const { name } = agent;
  const [open, setOpen] = useState(false);
  const parts: readonly Part[] = ["name", "job", "face", "model"];
  return (
    <>
      <Button
        disabled={!can}
        icon={Edit}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t`Edit`}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogPanel closeLabel={t`Close`}>
          <DialogTitle>{t`Edit ${name}`}</DialogTitle>
          <DialogBody>
            {/* Mounted only while open, so it starts from what core keeps. */}
            {open ? (
              <AgentForm
                can={can}
                id={formId}
                initial={typed}
                models={models}
                onSave={async (said) => {
                  if (await save(said)) {
                    setOpen(false);
                  }
                }}
                parts={parts}
              />
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogAction>{t`Cancel`}</DialogAction>
            <Button disabled={!can} form={formId} type="submit" variant="ink">
              {t`Save`}
            </Button>
          </DialogFooter>
        </DialogPanel>
      </Dialog>
    </>
  );
};

/** Delete, for good, behind a question; never the first agent. */
const DeleteAgent = ({
  name,
  can,
  remove,
}: {
  name: string;
  can: boolean;
  remove: () => Promise<void>;
}) => {
  const { t } = useLingui();
  return (
    <SectionCard
      actions={
        <AlertDialog>
          <AlertDialogTrigger
            disabled={!can}
            icon={Trash}
            size="sm"
            variant="danger"
          >
            {t`Delete`}
          </AlertDialogTrigger>
          <AlertDialogPanel>
            <AlertDialogTitle>{t`Delete ${name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`It answers nobody, and its schedule and settings are removed. The chats people had with it stay theirs.`}
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
              <AlertDialogAction
                action={remove}
                failedLabel={t`Couldn't delete`}
                variant="danger"
              >
                {t`Delete for good`}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogPanel>
        </AlertDialog>
      }
      density="compact"
      description={t`To stop it for a while, turn it off instead.`}
      title={t`Delete ${name}`}
    >
      {null}
    </SectionCard>
  );
};

/** One agent's page body. */
export const AgentPage = ({
  agent,
  first,
  settings,
  teams,
  wakes,
  documents,
  people,
  editable,
  usable,
  usage,
  firstAccess,
  models,
  tab,
}: {
  agent: Agent;
  /** The company's first agent, whose reach is Settings › Stephen's. */
  first: boolean;
  settings: AgentSettings | undefined;
  teams: StephenReach["teams"];
  wakes: readonly AgentWake[];
  /** The documents it answers from; undefined where core didn't say. */
  documents: readonly AgentDocument[] | undefined;
  /** The company's people, whom a wake-up can work for. */
  people: readonly Member[];
  /** Whether the person may change agents at all. */
  editable: boolean;
  /** Whether the person may talk to it themselves. */
  usable: boolean;
  /** What it used of the models this month; none where core didn't say. */
  usage: AgentUsage | undefined;
  /**
   * The first agent's access: who reaches it in each chat app, what it
   * may do in each app, and the workflows people start by asking it. None
   * for any other agent.
   */
  firstAccess?: FirstAgentAccess | undefined;
  /** The models the organization chose, which an agent can be given. */
  models: readonly string[];
  tab: AgentTab;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const navigate = useNavigate();
  const instructionsId = useId();
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
  const typed: Typed = {
    name: agent.name,
    job: agent.job,
    instructions: agent.instructions,
    face: agent.face,
    model: agent.model,
  };
  // What a form says, over the agent as core has it now: a form saves its
  // own parts and never what another saved since it was shown.
  const save = async (said: Partial<Typed>): Promise<boolean> => {
    const done = await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await session.connections.changeAgent(agent.id, {
            ...typed,
            ...said,
            modelRole: agent.modelRole,
          });
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
      return true;
    });
    return done === true;
  };
  const remove = async (): Promise<void> => {
    const done = await run(async (session) => {
      await session.connections.deleteAgent(agent.id);
      return true;
    });
    if (done !== true) {
      // The dialog's button then says it failed, and why is under the header.
      throw new Error("The agent wasn't deleted.");
    }
    await navigate({ to: "/agents", replace: true });
  };
  const scheduled = wakesOn(wakes).length;
  const tabLink = (value: AgentTab, words: string) => (
    <TabsLink
      current={tab === value}
      key={value}
      render={
        <Link
          params={{ agent: agent.id }}
          replace
          search={value === "overview" ? {} : { tab: value }}
          to="/agents/$agent"
        />
      }
    >
      {words}
    </TabsLink>
  );
  return (
    <Page>
      <PageHeader
        actions={
          <div {...stylex.props(styles.actions)}>
            <Switch
              checked={on}
              disabled={!can}
              label={t`On`}
              onCheckedChange={(next) => {
                void change(async (session) => {
                  await session.connections.setAgentPaused(agent.id, !next);
                });
              }}
            />
            <EditAgent
              agent={agent}
              can={can}
              models={models}
              save={save}
              typed={typed}
            />
            {usable && on ? (
              <Button
                icon={Conversation}
                render={<Link search={{ agent: agent.id }} to="/" />}
                variant="ink"
              >
                {t`Chat`}
              </Button>
            ) : null}
          </div>
        }
        aside={<AgentStateBadge state={agent.state} />}
        description={agent.job === "" ? t`No job written yet` : agent.job}
        descriptionLines={2}
        tabs={
          <TabsNav label={t`${name}'s pages`}>
            {tabLink("overview", t`Overview`)}
            {tabLink("instructions", t`Instructions`)}
            {tabLink("access", t`Access`)}
            {tabLink(
              "schedule",
              scheduled === 0 ? t`Schedule` : t`Schedule (${scheduled})`
            )}
          </TabsNav>
        }
        title={
          <span {...stylex.props(styles.title)}>
            <AgentAvatar face={agent.face} />
            {name}
          </span>
        }
      />
      <AgentFailure>{failure}</AgentFailure>
      {tab === "overview" ? (
        <div {...stylex.props(styles.stack)}>
          <Facts
            agent={agent}
            first={first}
            settings={settings}
            teams={teams}
            usage={usage}
            wakes={wakes}
          />
          <RecentActivity usage={usage} wakes={wakes} />
          {first ? null : <DeleteAgent can={can} name={name} remove={remove} />}
        </div>
      ) : null}
      {tab === "instructions" ? (
        <div {...stylex.props(styles.stack)}>
          <SectionCard
            actions={
              <Button
                disabled={!can}
                form={instructionsId}
                size="sm"
                type="submit"
                variant="ink"
              >
                {t`Save`}
              </Button>
            }
            title={t`Instructions`}
          >
            <AgentForm
              can={can}
              id={instructionsId}
              initial={typed}
              key={`${agent.id}:${agent.instructions}`}
              onSave={async (said) => {
                await save(said);
              }}
              parts={["instructions"]}
            />
          </SectionCard>
          <AgentDocuments
            agent={agent}
            can={can}
            change={change}
            documents={documents}
            editable={editable}
          />
        </div>
      ) : null}
      {tab === "access" ? (
        <div {...stylex.props(styles.stack)}>
          {firstAccess === undefined ? (
            <Access
              agent={agent}
              can={can}
              change={change}
              settings={settings}
              teams={teams}
            />
          ) : (
            // The first agent's reach is the company's own, with a place
            // for each chat app and a row for each app: its settings
            // whole, as Settings › Stephen had them.
            <StephenSettings
              classes={firstAccess.classes}
              editable={editable}
              reach={firstAccess.reach}
              week={firstAccess.week}
              workflows={firstAccess.workflows}
            />
          )}
        </div>
      ) : null}
      {tab === "schedule" ? (
        <AgentWakes
          agent={agent}
          can={can}
          change={change}
          editable={editable}
          people={people}
          wakes={wakes}
        />
      ) : null}
    </Page>
  );
};
