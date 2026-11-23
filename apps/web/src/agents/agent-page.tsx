import type {
  Agent,
  AgentDocument,
  AgentSettings,
  AgentUsage,
  AgentWake,
} from "@grasp-os/shared/agents";
import type { ToolClassSetting } from "@grasp-os/shared/connect";
import type { InstructionFileText } from "@grasp-os/shared/instruction-files";
import type { Member } from "@grasp-os/shared/members";
import type { StephenReach } from "@grasp-os/shared/stephen-reach";
import type { StephenWeek } from "@grasp-os/shared/stephen-requests";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent } from "@grasp-os/ui/components/card";
import { Container } from "@grasp-os/ui/components/container";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { DropdownMenuMore } from "@grasp-os/ui/components/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { FieldGroup } from "@grasp-os/ui/components/field";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import {
  CalendarIcon,
  Icon,
  MessageSquareIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  TrashIcon,
} from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Fragment, useId, useState } from "react";
import type { ReactNode } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { modelName } from "../chat/composer.tsx";
import type { Session } from "../core.ts";
import { formatDollars } from "../format.ts";
import { Page } from "../frame/page.tsx";
import { InstructionFileEditor } from "../settings/instruction-file.tsx";
import {
  AudienceControl,
  appAudienceOf,
  audienceOf,
  chosenOf,
} from "../settings/stephen-audience.tsx";
import { classNames, StephenSettings } from "../settings/stephen-settings.tsx";
import type { AskableWorkflow } from "../settings/stephen-settings.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { AgentAppsPanel, workOutQuietly } from "./agent-apps-card.tsx";
import type { AgentAppsShown } from "./agent-apps-card.tsx";
import { AgentDocuments } from "./agent-documents.tsx";
import {
  AgentFailure,
  classesOn,
  nextWakeAt,
  useAudienceLine,
  wakesOn,
} from "./agent-facts.tsx";
import { AgentForm } from "./agent-form.tsx";
import type { Part, Typed } from "./agent-form.tsx";
import { AgentLook } from "./agent-look.tsx";
import { ShareAgent } from "./agent-share.tsx";
import { AgentWakes, useLast } from "./agent-wakes.tsx";
import { FactRow, SettingRow, SettingsCard } from "./settings-card.tsx";
import { agentTabOf } from "./tabs.tsx";
import type { AgentTab } from "./tabs.tsx";
import { forgetUnfinished, unfinishedOf } from "./unfinished-setup.ts";
import type { UnsavedInstructions } from "./unsaved-instructions.ts";

// One agent's page, for the company's admins, or a person's own agent's,
// for them alone, in Damsko's settings pattern: one column in the page's
// middle, a card of rows per topic, the controls on one edge. Its page
// header holds the agent (its figure, name, what it is for, whether it is
// on) and the things done most: Chat, and in "…" Edit (its name, job and
// model, in a dialog), turning it off and on, and Delete. Its parts are
// tabs under the header, the part in the address (`?tab=`) so a link can
// lead to an agent's access or its schedule:
//
// - Overview: its facts as rows (whom it answers, what it may do, when
//   it works on its own, its model, this month's use) and what it did
//   lately (its scheduled runs, and when it was last asked); Delete.
// - Instructions: what it is told (its instruction file, as every
//   instruction file is edited: settings/instruction-file.tsx), the apps
//   it may use (agent-apps-card.tsx) and the documents it answers from.
// - Access: whom it answers and what it may do, each kind of work a row.
//   The first agent's is the company's own, Settings › Stephen's whole.
// - Schedule: when it works on its own (agent-wakes.tsx).
//
// A person's own agent has no audience, class or schedule to set, so no
// Access or Schedule; its Overview offers it to the company
// (agent-share.tsx).
//
// Each layer only narrows the one above it: an agent has a class of
// tools for at most the people the company has it for. Core keeps it all
// and holds every agent to it from the next message (agent-builder.ts,
// agent-reach.ts, agent-wakes.ts). Every control saves at once and reads
// the page again.

/** What a page change asks of core, then the page read again. */
type Change = (action: (session: Session) => Promise<unknown>) => Promise<void>;

const styles = stylex.create({
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["3"],
  },
  // A tab's name and its count, a small step apart.
  counted: { display: "inline-flex", alignItems: "center", gap: space["2"] },
  // A setting's control at its own width beside its name, on a phone too.
  control: { display: "block", width: "10rem", maxWidth: "100%" },
  // The header, then the tab shown, as far apart as its cards.
  column: { display: "grid", gap: space["6"], width: "100%" },
  // A part's cards, as far apart as the column sets its own.
  stack: { display: "grid", gap: space["8"] },
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
  teams: StephenReach["teams"],
  own: boolean
): { who: string; may: string } => {
  const { t } = useLingui();
  const audienceLine = useAudienceLine(teams);
  if (own) {
    // A person's own agent has no settings of either: core holds both.
    return { who: t`Only you`, may: t`What Grasp may do for you` };
  }
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

/** What the agent used this month, as a fact row: how much and how often, never what. */
const UsageRow = ({ usage }: { usage: AgentUsage }) => {
  const { t } = useLingui();
  const monthName = useMonthName();
  const { requests, people } = usage;
  const before = formatDollars(usage.spentBefore);
  return (
    <FactRow
      info={[
        plural(requests, {
          one: "# request to a model",
          other: "# requests to a model",
        }),
        plural(people, { one: "for # person", other: "for # people" }),
        t`${before} the month before`,
      ].join(" · ")}
      label={monthName(usage.month)}
    >
      {formatDollars(usage.spent)}
    </FactRow>
  );
};

/**
 * The agent's facts, as rows of a settings card: what it is for, whom it
 * answers, how much it may do, when it works on its own, its model and
 * this month's use, every value on one edge, as Settings has its facts.
 */
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
  const own = agent.ownerId !== null;
  const { who, may } = useAccessWords(first, settings, teams, own);
  const scheduled = wakesOn(wakes).length;
  const next = nextWakeAt(wakes);
  const nextMoment = next === undefined ? "" : moment(next);
  return (
    <SettingsCard title={t`Details`}>
      {/* The control column, not each value's own width: a job is a
          sentence, which would leave its name no room on a phone. */}
      <FieldGroup>
        <FactRow
          label={t`Answers`}
          {...(own ? { info: t`In Grasp's chat` } : {})}
        >
          {who}
        </FactRow>
        <FactRow
          label={t`May do`}
          {...(own ? { info: t`As your company has set it, never more` } : {})}
        >
          {may}
        </FactRow>
        <FactRow label={t`On its own`}>
          {scheduled === 0
            ? t`Only when asked`
            : t`${scheduled} on a schedule, next ${nextMoment}`}
        </FactRow>
        <FactRow label={t`Model`}>
          {agent.model === null ? t`The asker's` : modelName(agent.model)}
        </FactRow>
        {usage === undefined ? null : <UsageRow usage={usage} />}
        {agent.changedAt === null ? null : (
          <FactRow label={t`Changed`}>{moment(agent.changedAt)}</FactRow>
        )}
      </FieldGroup>
    </SettingsCard>
  );
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
  const lastLine = useLast();
  const ran = wakes
    .flatMap((wake) =>
      wake.lastAt === null ? [] : [{ ...wake, lastAt: wake.lastAt }]
    )
    .toSorted((a, b) => b.lastAt.localeCompare(a.lastAt));
  const asked = usage?.lastAt ?? null;
  return (
    <SettingsCard title={t`Recent activity`}>
      {ran.length === 0 && asked === null ? (
        <Empty size="sm">
          <EmptyHeader>
            <EmptyDescription>{t`Nothing yet. What it does shows here.`}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup>
          {asked === null ? null : (
            <Item size="sm">
              <ItemMedia>
                <Icon icon={MessageSquareIcon} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{t`Last asked in a chat`}</ItemTitle>
                <ItemDescription>{moment(asked)}</ItemDescription>
              </ItemContent>
            </Item>
          )}
          {ran.map((wake, index) => (
            <Fragment key={wake.id}>
              {index === 0 && asked === null ? null : <ItemSeparator />}
              <Item size="sm">
                <ItemMedia>
                  <Icon icon={CalendarIcon} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{wake.opening}</ItemTitle>
                  <ItemDescription>
                    {lastLine(wake) ?? moment(wake.lastAt)}
                  </ItemDescription>
                </ItemContent>
              </Item>
            </Fragment>
          ))}
        </ItemGroup>
      )}
    </SettingsCard>
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
      <Empty variant="destructive">
        <EmptyHeader>
          <EmptyTitle>{t`Access isn't shown`}</EmptyTitle>
          <EmptyDescription>
            {t`Only the company's own admins see it. If that is you, load the page again.`}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <>
      {/* A card per topic, each titled (Damsko's settings pattern); the
          row doesn't name the agent again under the page's title. */}
      <SettingsCard title={t`Who may use it`}>
        <FieldGroup controls="fit">
          <SettingRow
            info={t`Nobody outside it can ask it anything, in Grasp or a chat app.`}
            label={t`Answers`}
          >
            <span {...stylex.props(styles.control)}>
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
            </span>
          </SettingRow>
        </FieldGroup>
      </SettingsCard>
      <SettingsCard
        info={t`Each as the company has it, or for fewer people. Never more.`}
        title={t`What it may do`}
      >
        <FieldGroup controls="fit">
          {settings.classes.map(({ toolClass, audience }) => {
            const className = i18n._(classNames[toolClass]);
            return (
              <SettingRow key={toolClass} label={className}>
                <span {...stylex.props(styles.control)}>
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
                </span>
              </SettingRow>
            );
          })}
        </FieldGroup>
      </SettingsCard>
    </>
  );
};

/**
 * What the agent is told: its instruction file, edited as every
 * instruction file is (core's instruction-files.ts). Saving works out the
 * apps it calls for, but for the first agent, which has none of its own.
 */
const AgentInstructions = ({
  agentId,
  first,
  saved,
  unsaved,
}: {
  agentId: string;
  first: boolean;
  /** Its file as it is now, null while never written; undefined where core didn't say. */
  saved: InstructionFileText | null | undefined;
  /** What was typed as it was made and couldn't be saved (unsaved-instructions.ts). */
  unsaved: UnsavedInstructions | undefined;
}) => {
  const { t } = useLingui();
  if (saved === undefined) {
    return (
      <Empty size="sm">
        <EmptyHeader>
          <EmptyDescription>{t`Not shown`}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const workOut = async (session: Session): Promise<void> => {
    await workOutQuietly(session, agentId);
  };
  return (
    <InstructionFileEditor
      description={t`What it should know and how it should work. Grasp's own rules always hold over these.`}
      file={{ scope: "agent", agentId }}
      label={t`Instructions`}
      onSaved={first ? undefined : workOut}
      saved={saved}
      unsaved={unsaved}
    />
  );
};

/** Edit: the agent's name, job, picture and model, in a dialog the head's menu opens. */
const EditAgent = ({
  agent,
  typed,
  models,
  can,
  save,
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  agent: Agent;
  typed: Typed;
  models: readonly string[];
  can: boolean;
  save: (said: Partial<Typed>) => Promise<boolean>;
}) => {
  const { t } = useLingui();
  const formId = useId();
  const { name } = agent;
  const parts: readonly Part[] = ["name", "job", "model"];
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`Edit ${name}`}</DialogTitle>
        </DialogHeader>
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
          <DialogClose>{t`Cancel`}</DialogClose>
          <Button disabled={!can} form={formId} size="sm" type="submit">
            {t`Save`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Delete, for good, behind a question the head's menu opens; never the first agent. */
const DeleteAgent = ({
  name,
  remove,
  open,
  setOpen,
}: {
  name: string;
  remove: () => Promise<void>;
  open: boolean;
  setOpen: (open: boolean) => void;
}) => {
  const { t } = useLingui();
  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Delete ${name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`It answers nobody, and its schedule and settings are removed. The chats people had with it stay theirs. To stop it for a while, turn it off instead.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel />
          {/* Works before it closes: the button says so, and that it failed. */}
          <Button
            errorLabel={t`Couldn't delete`}
            onClick={remove}
            size="sm"
            variant="destructive"
          >
            {t`Delete for good`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/**
 * The page's head: the agent's figure and name, what it is for under it,
 * whose it is and whether it is on beside it; Chat, the one button people
 * come for, and everything else (Edit, turning it off or on, Delete) in
 * "…" (Ruben, 21 November: the switch, Edit and Chat side by side were
 * cluttered). Its tabs stand under it.
 */
const AgentHead = ({
  agent,
  first,
  can,
  usable,
  change,
  onEdit,
  onDelete,
  tabs,
}: {
  agent: Agent;
  first: boolean;
  can: boolean;
  usable: boolean;
  change: Change;
  onEdit: () => void;
  onDelete: () => void;
  tabs: ReactNode;
}) => {
  const { t } = useLingui();
  const { name } = agent;
  const on = agent.state === "on";
  const own = agent.ownerId !== null;
  return (
    <PageHeader
      actions={
        // One button, the one people come for; the rest in "…".
        <span {...stylex.props(styles.actions)}>
          <DropdownMenuMore
            aria-label={t`More for ${name}`}
            items={[
              {
                label: t`Edit`,
                icon: PencilIcon,
                disabled: !can,
                onSelect: () => {
                  onEdit();
                },
              },
              {
                label: on ? t`Turn off` : t`Turn on`,
                icon: on ? PauseIcon : PlayIcon,
                disabled: !can,
                onSelect: () => {
                  void change(async (session) => {
                    await session.connections.setAgentPaused(agent.id, on);
                  });
                },
              },
              ...(first
                ? []
                : [
                    {
                      label: t`Delete`,
                      icon: TrashIcon,
                      variant: "destructive" as const,
                      disabled: !can,
                      onSelect: () => {
                        onDelete();
                      },
                    },
                  ]),
            ]}
            size="icon-sm"
          />
          {usable && on ? (
            <Button asChild size="sm">
              <Link search={{ agent: agent.id }} to="/">
                <Icon icon={MessageSquareIcon} />
                {t`Chat`}
              </Link>
            </Button>
          ) : null}
        </span>
      }
      // Beside its name: whether it works, always (Ruben, 21 November:
      // with the switch gone it was hard to tell), and whose it is when it
      // is the person's own.
      badge={
        <span {...stylex.props(styles.actions)}>
          {on ? (
            <Badge variant="success">{t`On`}</Badge>
          ) : (
            <Badge variant="warning">{t`Off`}</Badge>
          )}
          {own ? <Badge>{t`Just for you`}</Badge> : null}
        </span>
      }
      // What it is for, under its name: the details no longer repeat it.
      description={agent.job === "" ? undefined : agent.job}
      size="sm"
      tabs={tabs}
      title={name}
    />
  );
};

/** The tab row under the head: a person's own agent has no Access or Schedule. */
const AgentTabRow = ({
  own,
  scheduled,
}: {
  own: boolean;
  scheduled: number;
}) => {
  const { t } = useLingui();
  return (
    <TabsList aria-label={t`Parts of the agent`} variant="line">
      <TabsTrigger value="overview">{t`Overview`}</TabsTrigger>
      <TabsTrigger value="instructions">{t`Instructions`}</TabsTrigger>
      {own ? null : <TabsTrigger value="access">{t`Access`}</TabsTrigger>}
      {own ? null : (
        <TabsTrigger value="schedule">
          <span {...stylex.props(styles.counted)}>
            {t`Schedule`}
            {scheduled === 0 ? null : (
              <Badge size="sm" variant="secondary">
                {String(scheduled)}
              </Badge>
            )}
          </span>
        </TabsTrigger>
      )}
    </TabsList>
  );
};

/** One agent's page body. */
export const AgentPage = ({
  agent,
  first,
  settings,
  teams,
  wakes,
  instructions,
  unsaved,
  documents,
  apps,
  people,
  editable,
  usable,
  usage,
  firstAccess,
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
  /**
   * Its instruction file as it is now, null while never written;
   * undefined where core didn't say it.
   */
  instructions: InstructionFileText | null | undefined;
  /** What was typed as it was made and couldn't be saved (unsaved-instructions.ts). */
  unsaved?: UnsavedInstructions | undefined;
  /**
   * Its apps and the apps the company offers; undefined where core didn't
   * say them, and for the first agent, which has none of its own.
   */
  apps?: AgentAppsShown | undefined;
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
  /** Puts the tab chosen in the address. */
  onTab: (tab: AgentTab) => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const navigate = useNavigate();
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
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // What a new agent's setup couldn't save once it was made (unfinished-setup.ts).
  const [unfinished, setUnfinished] = useState(() => unfinishedOf(agent.id));
  const { name } = agent;
  const typed: Typed = {
    name: agent.name,
    job: agent.job,
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
  // A person's own agent: theirs alone, with no audience, class or
  // schedule to set, so no Access or Schedule.
  const own = agent.ownerId !== null;
  const shownTab =
    own && (tab === "access" || tab === "schedule") ? "overview" : tab;
  return (
    <Page>
      <Container align="center" size="sm">
        <Tabs
          // Every tab stays mounted, the others hidden: what is typed and
          // not yet saved on one stays while another is looked at.
          onValueChange={(next) => {
            onTab(agentTabOf(next));
          }}
          value={shownTab}
        >
          <div {...stylex.props(styles.column)}>
            <AgentHead
              agent={agent}
              can={can}
              change={change}
              first={first}
              onDelete={() => {
                setDeleting(true);
              }}
              onEdit={() => {
                setEditing(true);
              }}
              tabs={<AgentTabRow own={own} scheduled={wakesOn(wakes).length} />}
              usable={usable}
            />
            <EditAgent
              agent={agent}
              can={can}
              models={models}
              open={editing}
              save={save}
              setOpen={setEditing}
              typed={typed}
            />
            {first ? null : (
              <DeleteAgent
                name={name}
                open={deleting}
                remove={remove}
                setOpen={setDeleting}
              />
            )}
            <AgentFailure>{failure}</AgentFailure>
            {unfinished === undefined ? null : (
              // What its setup couldn't save once it was made: set here.
              <Alert
                onClose={() => {
                  forgetUnfinished(agent.id);
                  setUnfinished(undefined);
                }}
                variant="warning"
              >
                <AlertTitle>{t`${name} was made, but not everything you chose was saved`}</AlertTitle>
                <AlertDescription>{unfinished}</AlertDescription>
              </Alert>
            )}
            <TabsContent keepMounted value="overview">
              <div {...stylex.props(styles.stack)}>
                <Facts
                  agent={agent}
                  first={first}
                  settings={settings}
                  teams={teams}
                  usage={usage}
                  wakes={wakes}
                />
                {first ? null : (
                  <AgentLook agent={agent} can={can} save={save} />
                )}
                <RecentActivity usage={usage} wakes={wakes} />
                <ShareAgent agent={agent} can={can} change={change} />
              </div>
            </TabsContent>
            <TabsContent keepMounted value="instructions">
              <div {...stylex.props(styles.stack)}>
                {/* What it reads first (Ruben, 21 November: documents at the
                    top, for what is worked out of them), then what it is told. */}
                <AgentDocuments
                  agent={agent}
                  can={can}
                  change={change}
                  documents={documents}
                  editable={editable}
                />
                {/* No title: the tab says "Instructions" already. */}
                <Card aria-label={t`Instructions`} size="sm">
                  <CardContent>
                    <AgentInstructions
                      agentId={agent.id}
                      first={first}
                      saved={instructions}
                      unsaved={unsaved}
                    />
                  </CardContent>
                </Card>
                <AgentAppsPanel
                  agent={agent}
                  apps={apps}
                  can={can}
                  change={change}
                  editable={editable}
                  first={first}
                  people={people}
                  told={instructions?.text ?? ""}
                  wakes={wakes}
                />
              </div>
            </TabsContent>
            {own ? null : (
              <TabsContent keepMounted value="access">
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
                    // The first agent's reach is the company's own, with a
                    // place for each chat app and a row for each app: its
                    // settings whole, as Settings › Stephen had them.
                    <StephenSettings
                      classes={firstAccess.classes}
                      editable={editable}
                      reach={firstAccess.reach}
                      week={firstAccess.week}
                      workflows={firstAccess.workflows}
                    />
                  )}
                </div>
              </TabsContent>
            )}
            {own ? null : (
              <TabsContent keepMounted value="schedule">
                <AgentWakes
                  agent={agent}
                  can={can}
                  change={change}
                  editable={editable}
                  people={people}
                  wakes={wakes}
                />
              </TabsContent>
            )}
          </div>
        </Tabs>
      </Container>
    </Page>
  );
};
