import { agentAppOf } from "@grasp-os/shared/agents";
import type {
  Agent,
  AgentApp,
  AgentAppsWorkedOut,
  AgentWake,
} from "@grasp-os/shared/agents";
import type { CatalogEntry } from "@grasp-os/shared/connect";
import type { Member } from "@grasp-os/shared/members";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, PlusIcon, SparklesIcon } from "@grasp-os/ui/lib/icons";
import { size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { integrationKey } from "../connections/integrations.ts";
import type { Session } from "../core.ts";
import { formatList } from "../format.ts";
import { classNames } from "../settings/stephen-settings.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { AgentFailure } from "./agent-facts.tsx";
import { AppMark } from "./app-mark.tsx";
import { SettingsCard } from "./settings-card.tsx";
import { scoreOf, wordsOf } from "./setup/apps-recommend.ts";

// An agent's apps (core's agent-app-access.ts), on its Instructions part:
// the apps it may use, which whoever manages it takes off or adds by
// hand, and works out from its instructions. An agent with none listed
// uses any app its kinds of work allow, as before agents had apps; with
// some, only those. A settings card of Items, as the agent's documents
// are: Work out from its instructions in its head, a row per app, and
// the app to add at its foot. What working them out turned on and
// suggests is said under the rows: kinds of work that change or send
// things only with a press.

/** At most this many apps are suggested. */
const suggestedMost = 3;

/** An agent's apps and the apps the company offers, as its page reads them. */
export interface AgentAppsShown {
  apps: readonly AgentApp[] | undefined;
  offered: readonly Offered[];
  /** The apps connected now, by their catalog id: a suggestion says whether one needs connecting. */
  connected?: readonly string[];
  /** Who looks: whom a schedule it proposes works for, unless they pick another. */
  userId?: string;
}

/**
 * Works out `agentId`'s apps from its instructions, as they are saved:
 * nothing said where no model answers, as the card offers it again.
 */
export const workOutQuietly = async (
  session: Session,
  agentId: string
): Promise<void> => {
  try {
    await session.connections.workOutAgentApps(agentId);
  } catch {
    // Its apps stay as they were; the card works them out on a press.
  }
};

/** What a page change asks of core, then the page read again. */
type Change = (action: (session: Session) => Promise<unknown>) => Promise<void>;

/** An app the company offers, as the catalog has it. */
type Offered = Pick<
  CatalogEntry,
  "source" | "id" | "name" | "categories" | "description" | "logo"
>;

const styles = stylex.create({
  // What working the apps out said: its lines, then a row per thing to press.
  worked: {
    display: "grid",
    gap: space["2"],
    paddingInline: space["4"],
    paddingBlock: space["3"],
  },
  // The picker beside its Add: as wide as the row leaves it, up to the control column.
  pick: {
    display: "block",
    flexGrow: 1,
    minWidth: "12rem",
    maxWidth: size.fieldControlColumn,
  },
  foot: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    gap: space["2"],
    paddingInline: space["4"],
    paddingBlock: space["3"],
  },
});

/** A hairline before every row but the first. */
const Between = ({ index }: { index: number }) =>
  index === 0 ? null : <ItemSeparator />;

/** Apps its instructions name that the company doesn't offer, each to ask an admin for. */
const MissingApps = ({
  missing,
  agent,
  change,
  can,
}: {
  missing: readonly string[];
  agent: Agent;
  change: Change;
  can: boolean;
}) => {
  const { t } = useLingui();
  const [asked, setAsked] = useState<readonly string[]>([]);
  const { name: agentName } = agent;
  return missing.map((app, index) => (
    <Fragment key={app}>
      <Between index={index} />
      <Item size="sm">
        <ItemContent>
          <ItemTitle>{app}</ItemTitle>
        </ItemContent>
        <ItemActions>
          {asked.includes(app) ? (
            <Text as="span" color="muted" size="sm">
              {t`Asked for`}
            </Text>
          ) : (
            <Button
              aria-label={t`Ask for ${app}`}
              disabled={!can}
              onClick={() => {
                void change(async (session) => {
                  await session.connections.requestApp({
                    name: app,
                    why: t`For the agent ${agentName}.`,
                  });
                  setAsked((before) => [...before, app]);
                });
              }}
              size="sm"
              variant="ghost"
            >
              {t`Ask for it`}
            </Button>
          )}
        </ItemActions>
      </Item>
    </Fragment>
  ));
};

/** When its instructions say it works on its own: the schedule proposed, made only on a press, for whom the admin picks. */
const ProposedSchedule = ({
  schedule,
  agent,
  change,
  can,
  userId,
  people,
  wakes,
}: {
  schedule: { cron: string; opening: string };
  agent: Agent;
  change: Change;
  can: boolean;
  userId: string;
  people: readonly Member[];
  wakes: readonly AgentWake[];
}) => {
  const { t } = useLingui();
  const [person, setPerson] = useState(
    people.some((each) => each.userId === userId)
      ? userId
      : (people[0]?.userId ?? userId)
  );
  const { cron, opening } = schedule;
  // Made already, as its wake-ups say, not as this card last pressed.
  const made = wakes.some(
    (wake) => wake.cron === cron && wake.opening.trim() === opening.trim()
  );
  return (
    <>
      <Text size="sm">
        {t`Its instructions say it works on its own: ${cron} · ${opening}`}
      </Text>
      {made ? (
        <Text color="muted" size="sm">
          {t`Already one of its schedules.`}
        </Text>
      ) : (
        <div {...stylex.props(styles.foot)}>
          <span {...stylex.props(styles.pick)}>
            <Field disabled={!can}>
              <FieldLabel>{t`For whom`}</FieldLabel>
              <Select
                items={people.map(({ userId: id, name, email }) => ({
                  value: id,
                  label: name === "" ? email : name,
                }))}
                onValueChange={(value) => {
                  setPerson(value ?? "");
                }}
                value={person}
              >
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent />
              </Select>
            </Field>
          </span>
          <Button
            disabled={!can || person === ""}
            onClick={() => {
              void change(async (session) => {
                await session.connections.makeAgentWake(agent.id, {
                  cron,
                  opening,
                  personId: person,
                });
              });
            }}
            size="sm"
            variant="ghost"
          >
            {t`Add this schedule`}
          </Button>
        </div>
      )}
    </>
  );
};

/** What working the apps out said, under the card's rows. */
const WorkedOut = ({
  worked,
  agent,
  change,
  can,
  userId,
  people,
  wakes,
}: {
  worked: AgentAppsWorkedOut;
  agent: Agent;
  change: Change;
  can: boolean;
  userId: string | undefined;
  people: readonly Member[];
  wakes: readonly AgentWake[];
}) => {
  const { t, i18n } = useLingui();
  const { name } = agent;
  const added = formatList(worked.added.map((each) => each.name));
  const turned = formatList(
    worked.turnedOn.map((each) => i18n._(classNames[each]))
  );
  const missing = formatList(worked.missing);
  return (
    <div {...stylex.props(styles.worked)}>
      <Text size="sm">
        {added === ""
          ? t`No new app from its instructions.`
          : t`Added from its instructions: ${added}.`}
      </Text>
      {turned === "" ? null : (
        <Text size="sm">{t`Turned on, as it only reads: ${turned}.`}</Text>
      )}
      {missing === "" ? null : (
        <Text color="muted" size="sm">
          {t`Its instructions name apps your company doesn't offer: ${missing}.`}
        </Text>
      )}
      {worked.missing.length === 0 && worked.suggested.length === 0 ? null : (
        <ItemGroup>
          <MissingApps
            agent={agent}
            can={can}
            change={change}
            missing={worked.missing}
          />
          {worked.suggested.map((toolClass, index) => {
            const kind = i18n._(classNames[toolClass]);
            return (
              <Fragment key={toolClass}>
                <Between index={worked.missing.length + index} />
                <Item size="sm">
                  <ItemContent>
                    <ItemDescription>
                      {t`${name} also needs “${kind}”, which changes or sends things.`}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      disabled={!can}
                      onClick={() => {
                        void change(async (session) => {
                          await session.connections.setAgentToolClass(
                            agent.id,
                            toolClass,
                            { who: "asClass" }
                          );
                        });
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      {t`Turn on`}
                    </Button>
                  </ItemActions>
                </Item>
              </Fragment>
            );
          })}
        </ItemGroup>
      )}
      {worked.schedule === undefined || userId === undefined ? null : (
        <ProposedSchedule
          agent={agent}
          can={can}
          change={change}
          people={people}
          schedule={worked.schedule}
          userId={userId}
          wakes={wakes}
        />
      )}
    </div>
  );
};

/** The Apps card: `agent`'s apps, and the ways to change them. */
const AgentApps = ({
  agent,
  apps,
  offered,
  editable,
  can,
  change,
  userId,
  people,
  wakes,
  connected,
  told,
}: {
  agent: Agent;
  /** Its apps; undefined where core didn't say. */
  apps: readonly AgentApp[] | undefined;
  /** The apps the company offers, which it can be given. */
  offered: readonly Offered[];
  /** The apps connected now, by their catalog id. */
  connected: readonly string[];
  /** Its instructions as they are saved, which its suggestions read. */
  told: string;
  /** Whether the person may change it at all. */
  editable: boolean;
  /** Whether they may now: not while a change is on its way to core. */
  can: boolean;
  change: Change;
  userId?: string | undefined;
  /** The company's people, whom a proposed schedule can work for. */
  people: readonly Member[];
  /** Its wake-ups now: a proposal already made is shown as made. */
  wakes: readonly AgentWake[];
}) => {
  const { t } = useLingui();
  const whereFrom = (each: AgentApp): string => {
    if (each.state === "removed") {
      return t`Taken off: never added back from its instructions`;
    }
    return each.source === "instructions"
      ? t`Added from its instructions`
      : t`Added by hand`;
  };
  const { busy, failure, run } = useCoreAction();
  const [worked, setWorked] = useState<AgentAppsWorkedOut>();
  const [picked, setPicked] = useState("");
  const { name } = agent;
  const on = new Set(
    (apps ?? []).filter(({ state }) => state === "on").map(({ app }) => app)
  );
  // Core limits it once it has any row, one taken off included.
  const limitWords = (): string => {
    if ((apps ?? []).length === 0) {
      return t`${name} may use any app its kinds of work allow. Give it apps, and it uses only those.`;
    }
    return on.size === 0
      ? t`${name} may use no app: each was taken off. Give one back, or add one.`
      : t`${name} uses only these apps, as far as its kinds of work allow.`;
  };
  const addable = offered.filter(
    ({ source, id }) => !on.has(agentAppOf(source, id))
  );
  // The apps its job, name and instructions point to and it hasn't got,
  // the best first (Ruben, 21 November: "you need to connect this").
  const words = wordsOf(`${agent.name} ${agent.job} ${told}`);
  const suggested = addable
    .map((app) => ({ app, score: scoreOf(app, words) }))
    .filter(({ score }) => score > 0)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, suggestedMost)
    .map(({ app }) => app);
  const set = (app: string, next: boolean): void => {
    void change(async (session) => {
      await session.connections.setAgentApp(agent.id, app, next);
    });
  };
  const workOut = (): void => {
    void run(async (session) => {
      // Read again however it ends: core may have added some.
      await changeThenRefresh(
        async () => {
          setWorked(await session.connections.workOutAgentApps(agent.id));
        },
        async () => {
          await change(async () => {
            // Only the page read again.
          });
        }
      );
    });
  };
  return (
    <>
      <SettingsCard
        actions={
          editable ? (
            <Button
              disabled={!can || busy}
              onClick={workOut}
              size="xs"
              variant="secondary"
            >
              <Icon icon={SparklesIcon} />
              {busy
                ? t`Reading its instructions…`
                : t`Work out from its instructions`}
            </Button>
          ) : undefined
        }
        description={apps === undefined ? undefined : limitWords()}
        title={t`Apps`}
      >
        {apps === undefined ? (
          <Empty size="sm" variant="destructive">
            <EmptyHeader>
              <EmptyDescription>{t`Its apps couldn't be loaded. Reload the page.`}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {apps === undefined || apps.length === 0 ? null : (
          <ItemGroup aria-label={t`Apps`}>
            {apps.map((each, index) => {
              const app = each.name;
              return (
                <Fragment key={each.app}>
                  <Between index={index} />
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>{app}</ItemTitle>
                      <ItemDescription>{whereFrom(each)}</ItemDescription>
                    </ItemContent>
                    {editable ? (
                      <ItemActions>
                        <Button
                          aria-label={
                            each.state === "on"
                              ? t`Take ${app} off`
                              : t`Give ${app} back`
                          }
                          disabled={!can}
                          onClick={() => {
                            set(each.app, each.state !== "on");
                          }}
                          size="sm"
                          variant="ghost"
                        >
                          {each.state === "on" ? t`Take off` : t`Give back`}
                        </Button>
                      </ItemActions>
                    ) : null}
                  </Item>
                </Fragment>
              );
            })}
          </ItemGroup>
        )}
        {editable && suggested.length > 0 ? (
          <ItemGroup aria-label={t`Suggested apps`}>
            {suggested.map((app, index) => {
              const linked = connected.includes(app.id);
              const appName = app.name;
              return (
                <Fragment key={agentAppOf(app.source, app.id)}>
                  <Between index={index} />
                  <Item size="sm">
                    <ItemMedia>
                      <AppMark logo={app.logo} name={app.name} />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{appName}</ItemTitle>
                      <ItemDescription>
                        {linked
                          ? t`Suggested for ${name}`
                          : t`Suggested for ${name}: connect it first`}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {linked ? (
                        <Button
                          aria-label={t`Add ${appName}`}
                          disabled={!can}
                          onClick={() => {
                            set(agentAppOf(app.source, app.id), true);
                          }}
                          size="sm"
                          variant="secondary"
                        >
                          <Icon icon={PlusIcon} />
                          {t`Add`}
                        </Button>
                      ) : (
                        <Button asChild size="sm" variant="secondary">
                          <Link
                            aria-label={t`Connect ${appName}`}
                            params={{
                              integration: integrationKey(app.source, app.id),
                            }}
                            to="/integrations/$integration"
                          >
                            {t`Connect`}
                          </Link>
                        </Button>
                      )}
                    </ItemActions>
                  </Item>
                </Fragment>
              );
            })}
          </ItemGroup>
        ) : null}
        {editable && apps !== undefined ? (
          <div {...stylex.props(styles.foot)}>
            <span {...stylex.props(styles.pick)}>
              <Field disabled={!can || addable.length === 0}>
                <Select
                  items={addable.map(({ source, id, name: appName }) => ({
                    value: agentAppOf(source, id),
                    label: appName,
                  }))}
                  onValueChange={(value) => {
                    setPicked(value ?? "");
                  }}
                  value={picked === "" ? null : picked}
                >
                  <SelectTrigger
                    aria-label={t`An app to give ${name}`}
                    size="sm"
                  >
                    <SelectValue placeholder={t`Choose an app`} />
                  </SelectTrigger>
                  <SelectContent />
                </Select>
              </Field>
            </span>
            <Button
              disabled={!can || picked === ""}
              onClick={() => {
                set(picked, true);
                setPicked("");
              }}
              size="sm"
              variant="ghost"
            >
              {t`Add`}
            </Button>
          </div>
        ) : null}
        {worked === undefined ? null : (
          <WorkedOut
            agent={agent}
            can={can}
            change={change}
            people={people}
            userId={userId}
            wakes={wakes}
            worked={worked}
          />
        )}
      </SettingsCard>
      {/* Why a change failed, under the card it was made in. */}
      <AgentFailure>{failure}</AgentFailure>
    </>
  );
};

/**
 * The Apps card of an agent's page: none for the company's first agent,
 * whose apps are the company's (Access).
 */
export const AgentAppsPanel = ({
  agent,
  apps,
  first,
  editable,
  can,
  change,
  people,
  wakes,
  told,
}: {
  agent: Agent;
  apps: AgentAppsShown | undefined;
  /** Its instructions as saved, which its suggestions read. */
  told: string;
  first: boolean;
  editable: boolean;
  can: boolean;
  change: Change;
  people: readonly Member[];
  wakes: readonly AgentWake[];
}) =>
  first ? null : (
    <AgentApps
      agent={agent}
      apps={apps?.apps}
      can={can}
      change={change}
      editable={editable}
      connected={apps?.connected ?? []}
      offered={apps?.offered ?? []}
      told={told}
      people={people}
      userId={apps?.userId}
      wakes={wakes}
    />
  );
