import type { TriggerKind } from "@grasp-os/shared/workflow-triggers";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { formatNumber } from "../format.ts";
import { Badge } from "../grasp/badge/index.ts";
import type { BadgeTone } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { Workflow } from "../grasp/icons/index.ts";
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "../grasp/item/index.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../grasp/table/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { stateOf } from "./overview.ts";
import type {
  OverviewRow,
  RowTrigger,
  TriggersByWorkflow,
  WorkflowState,
} from "./overview.ts";
import { triggerBlockText } from "./trigger-block.ts";

// The Workflows page (direction C, Ruben's pick of 23 November): one
// table across the page, a row a workflow, what needs the reader first.
// Each row says, in words anyone reads, how the workflow stands now, whose
// it is, how its last 7 days went, when it last ran and what starts it
// next. Below 1344 px the columns no longer fit, so each workflow stacks
// as a card with the same facts. Each row and card opens its workflow.

/** How a workflow stands, in the word its Now column leads with. */
const nowWords: Readonly<Record<WorkflowState, MessageDescriptor>> = {
  failing: msg({ message: "Needs a fix", context: "how a workflow stands" }),
  waiting: msg({ message: "Needs you", context: "how a workflow stands" }),
  paused: msg({ message: "Paused", context: "a workflow someone paused" }),
  blocked: msg({
    message: "Not starting",
    context: "how a workflow stands: nothing can start it yet",
  }),
  live: msg({ message: "On", context: "how a workflow stands: it runs" }),
  building: msg({ message: "Not live yet", context: "how a workflow stands" }),
};

const nowTones: Readonly<Record<WorkflowState, BadgeTone>> = {
  failing: "danger",
  waiting: "attention",
  paused: "neutral",
  blocked: "neutral",
  live: "success",
  building: "neutral",
};

/** What starts a workflow, for its Next column, where no time or address says it. */
const startWords: Readonly<Record<TriggerKind, MessageDescriptor>> = {
  schedule: msg({
    message: "On a schedule",
    context: "what starts a workflow",
  }),
  connector: msg({
    message: "On each event",
    context: "what starts a workflow",
  }),
  email: msg({ message: "On each email", context: "what starts a workflow" }),
  webhook: msg({
    message: "On each webhook call",
    context: "what starts a workflow",
  }),
};

const dayMs = 86_400_000;

/** The start of `day` by the reader's calendar, in milliseconds. */
const midnight = (day: Date): number =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();

/** How many days `date` is from today, by the reader's calendar: -1 yesterday, 1 tomorrow. */
const daysFromToday = (date: Date): number =>
  Math.round((midnight(date) - midnight(new Date())) / dayMs);

/**
 * When something happened or happens, as the overview says it: "Today
 * 11:20", "Yesterday 15:40" or "Tomorrow 08:00", else the day, its date
 * and the time ("Mon 30 Nov, 07:00").
 */
const whenOf = (at: string, i18n: I18n): string => {
  const date = new Date(at);
  const time = new Intl.DateTimeFormat(i18n.locale, {
    timeStyle: "short",
  }).format(date);
  const days = daysFromToday(date);
  if (days === 0) {
    return i18n._(msg`Today ${time}`);
  }
  if (days === -1) {
    return i18n._(msg`Yesterday ${time}`);
  }
  if (days === 1) {
    return i18n._(msg`Tomorrow ${time}`);
  }
  return new Intl.DateTimeFormat(i18n.locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

/** What starts a trigger's run: its next time, the address it reads, or its kind. */
const triggerWords = (trigger: RowTrigger, i18n: I18n): string => {
  const { address, nextAt } = trigger;
  if (nextAt !== null) {
    return whenOf(nextAt, i18n);
  }
  // One core made up (`trigger-` and random bits) says nothing to a reader.
  if (address !== null && !address.startsWith("trigger-")) {
    return i18n._(msg`On each email to ${address}`);
  }
  return i18n._(startWords[trigger.kind]);
};

/**
 * What starts a workflow next (its Next column): its resume while paused,
 * an admin while its trigger waits for one, else its first trigger, or
 * someone by hand when it has none. Undefined before a version is live,
 * and while its triggers aren't read (core lists a user only their own).
 */
const nextOf = (
  row: OverviewRow,
  triggers: readonly RowTrigger[] | undefined,
  admin: boolean,
  i18n: I18n
): string | undefined => {
  if (row.paused) {
    return i18n._(msg`When resumed`);
  }
  if (row.version === null || triggers === undefined) {
    return undefined;
  }
  if (row.blocked?.why === "waiting") {
    return admin
      ? i18n._(msg`When you allow it`)
      : i18n._(msg`When an admin allows it`);
  }
  const [first] = triggers;
  if (first === undefined) {
    return i18n._(
      msg({ message: "By hand", context: "what starts a workflow" })
    );
  }
  const words = triggerWords(first, i18n);
  const more = formatNumber(triggers.length - 1);
  return triggers.length > 1 ? i18n._(msg`${words}, and ${more} more`) : words;
};

/** A workflow's facts, worded once for its row and its card alike. */
interface Facts {
  state: WorkflowState;
  now: string;
  /** What it asks of the reader, under how it stands: its runs that wait on them. */
  asks: string | undefined;
  runs: string;
  failed: string | undefined;
  last: string;
  next: string | undefined;
}

const useFacts = (
  row: OverviewRow,
  triggers: readonly RowTrigger[] | undefined,
  admin: boolean
): Facts => {
  const { t, i18n } = useLingui();
  const state = stateOf(row);
  let now = i18n._(nowWords[state]);
  if (state === "blocked" && row.blocked !== null) {
    now = triggerBlockText(row.blocked, i18n);
  } else if (state === "live" && row.lastRun === null) {
    now = t({
      message: "On, not used yet",
      context: "how a workflow stands: live, never run",
    });
  }
  const runs = formatNumber(row.runs ?? 0);
  const waiting = formatNumber(row.waiting);
  const failed = formatNumber(row.failed);
  // A user of it sees their own runs alone, so its figures are theirs.
  const own = row.role === "user";
  return {
    state,
    now,
    asks: row.waiting > 0 ? t`${waiting} waiting for a decision` : undefined,
    runs: own ? t`${runs} of yours done` : t`${runs} done`,
    failed: row.failed > 0 ? t`${failed} failed` : undefined,
    last: row.lastRun === null ? t`No runs yet` : whenOf(row.lastRun, i18n),
    next: nextOf(row, triggers, admin, i18n),
  };
};

const STACKED = "@media (width < 84rem)";

const styles = stylex.create({
  table: { display: { default: "block", [STACKED]: "none" } },
  cards: { display: { default: "none", [STACKED]: "block" } },
  // The workflow's name: a link whose press area stretches over its row.
  name: {
    color: "inherit",
    textDecoration: "none",
    outline: "none",
    "::after": { content: '""', position: "absolute", inset: 0 },
  },
  now: { display: "grid", justifyItems: "start", rowGap: grasp.space1 },
  asks: {
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  failed: { color: grasp.danger },
  card: {
    display: "grid",
    justifyItems: "start",
    rowGap: grasp.space2,
    marginBlockStart: grasp.space1,
  },
  facts: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: grasp.space4,
    rowGap: grasp.space1,
    color: grasp.ink,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  label: { color: grasp.muted },
});

/** How a workflow stands now: a toned dot and its word, over what it asks. */
const Now = ({ facts }: { facts: Facts }) => (
  <span {...stylex.props(styles.now)}>
    <Badge tone={nowTones[facts.state]} variant="dot">
      {facts.now}
    </Badge>
    {facts.asks === undefined ? null : (
      <span {...stylex.props(styles.asks)}>{facts.asks}</span>
    )}
  </span>
);

/** Its last 7 days: what it got done, then what failed, in red. */
const Week = ({ facts }: { facts: Facts }) => (
  <>
    {facts.runs}
    {facts.failed === undefined ? null : (
      <>
        {" · "}
        <span {...stylex.props(styles.failed)}>{facts.failed}</span>
      </>
    )}
  </>
);

/** One fact on a card: its quiet label, then its value. */
const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <span>
    <span {...stylex.props(styles.label)}>{label}</span> {children}
  </span>
);

interface RowProps {
  row: OverviewRow;
  triggers: readonly RowTrigger[] | undefined;
  admin: boolean;
}

/** One workflow as a row of the table. */
const WorkflowRow = ({ row, triggers, admin }: RowProps) => {
  const facts = useFacts(row, triggers, admin);
  return (
    <TableRow opens>
      <TableCell lead wrap>
        <Link
          data-row-target=""
          params={{ workflow: row.id }}
          to="/workflows/$workflow"
          {...stylex.props(styles.name)}
        >
          {row.name}
        </Link>
      </TableCell>
      <TableCell>
        <Now facts={facts} />
      </TableCell>
      <TableCell>{row.owner}</TableCell>
      <TableCell>
        <Week facts={facts} />
      </TableCell>
      <TableCell>{facts.last}</TableCell>
      <TableCell>{facts.next}</TableCell>
    </TableRow>
  );
};

/** One workflow as a card, below 1344 px: its name, how it stands, then its facts. */
const WorkflowCard = ({ row, triggers, admin }: RowProps) => {
  const { t } = useLingui();
  const facts = useFacts(row, triggers, admin);
  return (
    <Item
      render={<Link params={{ workflow: row.id }} to="/workflows/$workflow" />}
    >
      <ItemContent>
        <ItemTitle>{row.name}</ItemTitle>
        <span {...stylex.props(styles.card)}>
          <Now facts={facts} />
          <span {...stylex.props(styles.facts)}>
            {row.owner === null ? null : (
              <Fact label={t`Owner`}>{row.owner}</Fact>
            )}
            <Fact label={t`Last 7 days`}>
              <Week facts={facts} />
            </Fact>
            <Fact label={t({ message: "Last run", context: "a workflow's" })}>
              {facts.last}
            </Fact>
            {facts.next === undefined ? null : (
              <Fact
                label={t({
                  message: "Next",
                  context: "what starts a workflow next",
                })}
              >
                {facts.next}
              </Fact>
            )}
          </span>
        </span>
      </ItemContent>
    </Item>
  );
};

/**
 * Every workflow the person can open, what needs them first, each with
 * what starts it (`triggers`): a workflow absent from it shows nothing next.
 */
export const WorkflowRows = ({
  rows,
  triggers,
  builds,
  admin,
}: {
  /** Whether the reader may make a workflow; else they are told who does. */
  builds: boolean;
  /** Whether the reader is an admin, who allows a trigger. */
  admin: boolean;
  /** In the order of their phases (overview.ts). */
  rows: readonly OverviewRow[];
  triggers: TriggersByWorkflow;
}) => {
  const { t } = useLingui();
  if (rows.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia icon={Workflow} />
          <EmptyTitle>{t`No workflows yet`}</EmptyTitle>
          <EmptyDescription>
            {builds
              ? t`Workflows are made in chat: describe what should run on its own, and Grasp builds it.`
              : t`A workflow does routine work on its own, such as reading the invoices that arrive by email. Your admin or Grasp sets them up; one shared with you shows here.`}
          </EmptyDescription>
        </EmptyHeader>
        {builds ? (
          <EmptyContent>
            <Button render={<Link search={{}} to="/" />}>{t`Open Chat`}</Button>
          </EmptyContent>
        ) : null}
      </Empty>
    );
  }
  const label = t`Workflows`;
  return (
    <>
      <div {...stylex.props(styles.table)}>
        <Table aria-label={label} density="roomy">
          <TableHeader>
            <TableRow>
              <TableHead>{t`Workflow`}</TableHead>
              <TableHead>
                {t({ message: "Now", context: "how a workflow stands now" })}
              </TableHead>
              <TableHead>{t`Owner`}</TableHead>
              <TableHead>{t`Last 7 days`}</TableHead>
              <TableHead>
                {t({ message: "Last run", context: "a workflow's" })}
              </TableHead>
              <TableHead>
                {t({ message: "Next", context: "what starts a workflow next" })}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <WorkflowRow
                admin={admin}
                key={row.id}
                row={row}
                triggers={triggers.get(row.id)}
              />
            ))}
          </TableBody>
        </Table>
      </div>
      <div {...stylex.props(styles.cards)}>
        <ItemGroup aria-label={label} separated>
          {rows.map((row) => (
            <WorkflowCard
              admin={admin}
              key={row.id}
              row={row}
              triggers={triggers.get(row.id)}
            />
          ))}
        </ItemGroup>
      </div>
    </>
  );
};
