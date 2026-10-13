import type {
  RunHistoryEntry,
  RunHistoryError,
  RunHistoryPage,
} from "@grasp-os/shared/workflows";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  ActivityIcon,
  CircleAlertIcon,
  HandIcon,
  LockIcon,
  TimerIcon,
  Undo2Icon,
  ZapIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import {
  formatDuration,
  historyItems,
  firstHistory,
  stepOrdinal,
  withPage,
} from "./run-history.ts";
import type {
  HistoryAttempt,
  HistoryItem,
  LoadedHistory,
} from "./run-history.ts";

// A run's history as its page shows it (run-history.ts groups it): the
// run's own lifecycle, each step with its attempts and how long each
// took, the waits by kind, a compensation's steps, and what couldn't be
// read. A failure shows what core gives: the workflow's message to those
// who may read it, generic words to anyone else.

type Lifecycle = Extract<RunHistoryEntry, { kind: "lifecycle" }>;

const lifecycleLabels: Readonly<
  Record<Exclude<Lifecycle["status"], "compensating">, MessageDescriptor>
> = {
  queued: msg({ message: "Queued", context: "a run's lifecycle" }),
  running: msg({ message: "Running", context: "a run's lifecycle" }),
  waiting: msg({ message: "Waiting", context: "a run's lifecycle" }),
  paused: msg({ message: "Paused", context: "a run's lifecycle" }),
  completed: msg({ message: "Completed", context: "a run's lifecycle" }),
  failed: msg({ message: "Failed", context: "a run's lifecycle" }),
  cancelled: msg({ message: "Cancelled", context: "a run's lifecycle" }),
};

/** What the run did at a lifecycle entry, in words. */
export const lifecycleText = (entry: Lifecycle): string => {
  if (entry.status !== "compensating") {
    return i18n._(lifecycleLabels[entry.status]);
  }
  return entry.cause === "failure"
    ? i18n._(msg`Undoing its changes after a failure`)
    : i18n._(msg`Undoing its changes after it was cancelled`);
};

/**
 * A step's name: the task the version's review names it by, or, where
 * the review doesn't show it, "Step" and its number in the run.
 */
export const stepLabel = (stepId: string, taskId: string | null): string => {
  if (taskId !== null) {
    return taskId;
  }
  const ordinal = stepOrdinal(stepId);
  return ordinal === undefined
    ? i18n._(msg`A step`)
    : i18n._(msg`Step ${ordinal}`);
};

const attemptStates: Readonly<
  Record<HistoryAttempt["state"], MessageDescriptor>
> = {
  running: msg({ message: "Running", context: "an attempt of a step" }),
  completed: msg({ message: "Completed", context: "an attempt of a step" }),
  retrying: msg`Failed, tried again`,
  failed: msg({ message: "Failed", context: "an attempt of a step" }),
};

/** How long an attempt took; nothing while it runs or its start is unknown. */
const tookOf = ({ startedAt, endedAt }: HistoryAttempt): string | undefined =>
  startedAt === null || endedAt === null
    ? undefined
    : formatDuration(endedAt - startedAt, i18n.locale);

/**
 * Why a step failed, as core gives it: the workflow's own message, as
 * text, or core's generic words, with its code; words of the page's own
 * where core gave none.
 */
export const FailureText = ({ error }: { error: RunHistoryError }) => {
  const { t } = useLingui();
  const message = error.message.trim();
  return (
    <span className="text-destructive flex flex-col gap-0.5 text-xs">
      <span>{message === "" ? t`This step failed.` : message}</span>
      <code className="text-muted-foreground">{error.code}</code>
    </span>
  );
};

const AttemptLine = ({ attempt }: { attempt: HistoryAttempt }) => {
  const { t } = useLingui();
  const took = tookOf(attempt);
  const n = attempt.attempt;
  const state = i18n._(attemptStates[attempt.state]);
  return (
    <li className="flex flex-col gap-1">
      <span className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
        <span>{t`Attempt ${n}`}</span>
        <span>{state}</span>
        {took === undefined ? null : (
          <span className="tabular-nums">{took}</span>
        )}
      </span>
      {attempt.error === undefined ? null : (
        <FailureText error={attempt.error} />
      )}
    </li>
  );
};

/** A step, or a compensation's, with its attempts. */
const StepItem = ({
  item,
}: {
  item: Extract<HistoryItem, { type: "step" }>;
}) => {
  const { t } = useLingui();
  const label = stepLabel(item.stepId, item.taskId);
  const first = item.attempts.at(0);
  const last = item.attempts.at(-1);
  const startedAt = first?.startedAt ?? null;
  const endedAt = last?.endedAt ?? null;
  const took =
    startedAt === null || endedAt === null
      ? undefined
      : formatDuration(endedAt - startedAt, i18n.locale);
  const state = last?.state;
  // One attempt that went well needs no line of its own.
  const showAttempts =
    item.attempts.length > 1 ||
    item.attempts.some((attempt) => attempt.error !== undefined);
  return (
    <li className="bg-card flex flex-col gap-2 rounded-xl border px-4 py-3 shadow-xs">
      <span className="flex flex-wrap items-center gap-2">
        {item.kind === "compensation" ? (
          <Undo2Icon aria-hidden="true" className="size-4" />
        ) : null}
        <span className="min-w-0 flex-1 font-medium">
          {item.kind === "compensation" ? t`Undoing ${label}` : label}
        </span>
        {state === "failed" ? (
          <Badge variant="destructive">
            <Trans context="an attempt of a step">Failed</Trans>
          </Badge>
        ) : null}
        {state === "running" || state === "retrying" ? (
          <Badge variant="outline">
            <Trans context="an attempt of a step">Running</Trans>
          </Badge>
        ) : null}
        {took === undefined ? null : (
          <span className="text-muted-foreground text-xs tabular-nums">
            {took}
          </span>
        )}
      </span>
      {startedAt === null ? null : (
        <span className="text-muted-foreground text-xs">
          {formatDateTime(startedAt)}
        </span>
      )}
      {showAttempts ? (
        <ol className="flex flex-col gap-2">
          {item.attempts.map((attempt) => (
            <AttemptLine attempt={attempt} key={attempt.attempt} />
          ))}
        </ol>
      ) : null}
    </li>
  );
};

type WaitKind = Extract<HistoryItem, { type: "wait" }>["waitKind"];

const waitIcons: Readonly<Record<WaitKind, LucideIcon>> = {
  timer: TimerIcon,
  event: ZapIcon,
  decision: HandIcon,
  blocked: LockIcon,
};

/** What a wait waits for, in words: of `label`'s step, when it names one. */
export const waitText = (kind: WaitKind, label: string | null): string => {
  if (kind === "timer") {
    return i18n._(msg`Waiting for a set time`);
  }
  if (kind === "event") {
    return i18n._(msg`Waiting for an event`);
  }
  if (kind === "decision") {
    return label === null
      ? i18n._(msg`Waiting for a decision`)
      : i18n._(msg`Waiting for the decision ${label}`);
  }
  return label === null
    ? i18n._(msg`A change waits for approval by the person the run acts for`)
    : i18n._(
        msg`A change by ${label} waits for approval by the person the run acts for`
      );
};

const WaitItem = ({
  item,
}: {
  item: Extract<HistoryItem, { type: "wait" }>;
}) => {
  const { t } = useLingui();
  const Icon = waitIcons[item.waitKind];
  const { openedAt, closedAt, deadline } = item;
  const until = deadline === null ? undefined : formatDateTime(deadline);
  const took =
    openedAt === null || closedAt === null
      ? undefined
      : formatDuration(closedAt - openedAt, i18n.locale);
  return (
    <li className="flex flex-col gap-1 rounded-xl border border-dashed px-4 py-3">
      <span className="flex flex-wrap items-center gap-2">
        <Icon aria-hidden="true" className="size-4" />
        <span className="min-w-0 flex-1">
          {waitText(item.waitKind, item.taskId)}
        </span>
        {closedAt === null ? (
          <Badge variant="outline">
            <Trans context="a wait of a run">Open</Trans>
          </Badge>
        ) : null}
        {took === undefined ? null : (
          <span className="text-muted-foreground text-xs tabular-nums">
            {took}
          </span>
        )}
      </span>
      <span className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
        {openedAt === null ? null : <span>{formatDateTime(openedAt)}</span>}
        {until === undefined ? null : <span>{t`Until ${until}`}</span>}
      </span>
    </li>
  );
};

const Item = ({ item }: { item: HistoryItem }) => {
  const { t } = useLingui();
  if (item.type === "step") {
    return <StepItem item={item} />;
  }
  if (item.type === "wait") {
    return <WaitItem item={item} />;
  }
  if (item.type === "unreadable") {
    const { sequence } = item;
    return (
      <li className="text-muted-foreground flex flex-wrap items-center gap-2 px-4 py-1 text-xs">
        <CircleAlertIcon aria-hidden="true" className="size-4" />
        <span>{t`Entry ${sequence} can't be read.`}</span>
        <span>{formatDateTime(item.at)}</span>
      </li>
    );
  }
  return (
    <li className="text-muted-foreground flex flex-wrap items-center gap-2 px-4 py-1 text-xs">
      <ActivityIcon aria-hidden="true" className="size-4" />
      <span className="text-foreground font-medium">
        {lifecycleText(item.entry)}
      </span>
      <span>{formatDateTime(item.at)}</span>
    </li>
  );
};

/**
 * A run's history read so far, oldest first, and a way to read more
 * while core has more: `onMore` reads the next page, `busy` while it
 * does, `failure` why it couldn't.
 */
export const HistoryView = ({
  entries,
  hasMore,
  busy = false,
  failure,
  onMore,
}: {
  entries: readonly RunHistoryEntry[];
  hasMore: boolean;
  busy?: boolean;
  failure?: string;
  onMore: () => void;
}) => {
  const { t } = useLingui();
  const items = historyItems(entries);
  if (items.length === 0 && !hasMore) {
    return (
      <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
        <Trans>Nothing is recorded for this run.</Trans>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ol aria-label={t`Run history`} className="flex flex-col gap-2">
        {items.map((item) => (
          <Item item={item} key={item.id} />
        ))}
      </ol>
      {hasMore ? (
        <Button
          className="self-center"
          disabled={busy}
          onClick={onMore}
          variant="outline"
        >
          {busy ? t`Loading…` : t`Load more`}
        </Button>
      ) : null}
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** How many entries each page of a run's history reads. */
export const historyPageSize = 50;

/**
 * A run's history from its first page, `first`, reading the next page
 * from core each time the person asks for more.
 */
export const RunHistory = ({
  run,
  first,
}: {
  run: string;
  first: RunHistoryPage;
}) => {
  const { busy, failure, run: read } = useCoreAction();
  // Read once: the page keys this by `run`, so another run starts afresh.
  const [loaded, setLoaded] = useState<LoadedHistory>(() =>
    firstHistory(run, first)
  );
  const more = async (): Promise<void> => {
    // The run and cursor of the history as it is now: the page read is
    // added only to that same history, at that same place.
    const { run: of, cursor } = loaded;
    if (cursor === null) {
      return;
    }
    const page = await read(
      async (session) =>
        await session.workflows.history(of, {
          pageSize: historyPageSize,
          cursor,
        })
    );
    if (page !== undefined) {
      setLoaded((previous) => withPage(previous, { run: of, cursor }, page));
    }
  };
  return (
    <HistoryView
      busy={busy}
      entries={loaded.entries}
      failure={failure}
      hasMore={loaded.cursor !== null}
      onMore={() => {
        void more();
      }}
    />
  );
};
