import type {
  ImprovementSignal,
  ImprovementSignals,
} from "@grasp-os/shared/signals";
import { signalWindowDays } from "@grasp-os/shared/signals";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Await, Link } from "@tanstack/react-router";
import {
  CircleDollarSignIcon,
  ClockIcon,
  SearchXIcon,
  TriangleAlertIcon,
  UndoIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { formatDate } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { signalKinds } from "./board.ts";
import type { SignalKind } from "./board.ts";
import { ItemMark } from "./dashboard-card.tsx";
import { WidgetBlock } from "./widget-block.tsx";

// What could be better, from the signals core works out daily: workflows
// that keep failing, waiting or being corrected, what they cost, and
// searches that found nothing. Each in plain words, with the counts core
// gives (never a score or a ranking), linking to what it is about, and
// "Ask Grasp" where a chat can help: asking the agent to fix a run that
// failed. Admins see every improvement signal, an App's builders that
// App's; someone with none to see has no widget. On the dashboard's widget board, its block counts the
// signals by kind, and its full view lists every one.

/** What the dashboard read of the signals: none for someone they don't apply to. */
export interface Signals {
  improvement: ImprovementSignals | undefined;
  /** App names by ID. */
  appNames: ReadonlyMap<string, string>;
}

/** Each kind of signal's mark and name, as its rows and the block's counts show them. */
export const signalKindLooks: Record<
  SignalKind,
  { icon: LucideIcon; name: MessageDescriptor }
> = {
  failing_step: { icon: TriangleAlertIcon, name: msg`Keeps failing` },
  waiting_for_person: { icon: ClockIcon, name: msg`Waiting for a person` },
  correction: { icon: UndoIcon, name: msg`Often corrected` },
  cost_per_run: { icon: CircleDollarSignIcon, name: msg`Model cost` },
  unanswered_question: { icon: SearchXIcon, name: msg`Unanswered question` },
};

/** A duration in whole days, or hours under a day, as words. */
const waitedFor = (ms: number, t: ReturnType<typeof useLingui>["t"]) => {
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  const days = Math.floor(hours / 24);
  return days === 0
    ? t`${plural(hours, { one: "# hour", other: "# hours" })}`
    : t`${plural(days, { one: "# day", other: "# days" })}`;
};

/** US dollars, as the page's language writes them. */
const dollars = (amount: number, locale: string): string =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(amount);

/** One signal's row: its mark, kind, what it says, and its next step. */
const SignalRow = ({
  kind,
  children,
  action,
}: {
  kind: SignalKind;
  children: ReactNode;
  action?: ReactNode;
}) => {
  const { i18n } = useLingui();
  const { icon, name } = signalKindLooks[kind];
  return (
    <li className="flex min-h-14 items-center gap-3 border-t px-4 py-2">
      <ItemMark icon={icon} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-muted-foreground text-xs">{i18n._(name)}</span>
        <span>{children}</span>
      </div>
      {action}
    </li>
  );
};

/** The workflow a signal is about, linking to it; its App without one; an independent workflow by name. */
const About = ({
  signal,
  appNames,
}: {
  signal: ImprovementSignal;
  appNames: ReadonlyMap<string, string>;
}) => {
  const { t } = useLingui();
  const { app, workflow } = signal;
  if (app === null) {
    // An independent workflow's, by its name: it has no App to go to.
    return <span>{workflow ?? t`your organization`}</span>;
  }
  const name = appNames.get(app) ?? app;
  return workflow === null ? (
    <Link className="underline" params={{ app }} to="/apps/$app">
      {name}
    </Link>
  ) : (
    <span>{workflow}</span>
  );
};

const ImprovementRow = ({
  signal,
  appNames,
}: {
  signal: ImprovementSignal;
  appNames: ReadonlyMap<string, string>;
}) => {
  const { t, i18n } = useLingui();
  const about = <About appNames={appNames} signal={signal} />;
  const days = signalWindowDays;
  const step = signal.subject ?? "–";
  if (signal.kind === "waiting_for_person") {
    const { open } = signal.evidence;
    const waited = waitedFor(signal.value, t);
    return (
      <SignalRow kind="waiting_for_person">
        <Trans>
          {about} has{" "}
          <Plural one="# decision open" other="# decisions open" value={open} />
          ; the oldest has waited {waited}.
        </Trans>
      </SignalRow>
    );
  }
  if (signal.kind === "failing_step") {
    const { failures, runs } = signal.evidence;
    return (
      <SignalRow kind="failing_step">
        <Trans>
          Step {step} of {about} failed in {failures} of{" "}
          <Plural one="# run" other="# runs" value={runs} /> in{" "}
          <Plural one="the last day" other="the last # days" value={days} />.
        </Trans>
      </SignalRow>
    );
  }
  if (signal.kind === "correction") {
    const { rejected, answered } = signal.evidence;
    return (
      <SignalRow kind="correction">
        <Trans>
          People rejected {rejected} of{" "}
          <Plural one="# answer" other="# answers" value={answered} /> at step{" "}
          {step} of {about} in{" "}
          <Plural one="the last day" other="the last # days" value={days} />.
        </Trans>
      </SignalRow>
    );
  }
  if (signal.kind === "cost_per_run") {
    const { runs } = signal.evidence;
    const cost = dollars(signal.value, i18n.locale);
    return (
      <SignalRow kind="cost_per_run">
        <Trans>
          {about} cost {cost} a run in model calls, over{" "}
          <Plural one="# run" other="# runs" value={runs} /> in{" "}
          <Plural one="the last day" other="the last # days" value={days} />.
        </Trans>
      </SignalRow>
    );
  }
  const { searches, askers } = signal.evidence;
  return (
    <SignalRow kind="unanswered_question">
      <Trans>
        A Knowledge search from {about} found nothing{" "}
        <Plural one="once" other="# times" value={searches} />, by{" "}
        <Plural one="# asker" other="# askers" value={askers} />.
      </Trans>
    </SignalRow>
  );
};

/** How many kinds the block counts at most; the full view has them all. */
const kindsShown = 4;

/** Every signal, one row each, with what can be done about it. */
const SignalList = ({ signals }: { signals: Signals }) => {
  const { t } = useLingui();
  return (
    <div className="overflow-hidden rounded-xl border">
      {/* Each row draws its line on top: the frame stands for the first. */}
      <ul aria-label={t`Could be better`} className="-mt-px">
        {signals.improvement?.signals.map((signal) => (
          <ImprovementRow
            appNames={signals.appNames}
            key={`${signal.kind}:${signal.app ?? ""}:${signal.workflow ?? ""}:${signal.subject ?? ""}`}
            signal={signal}
          />
        ))}
      </ul>
    </div>
  );
};

/** How many signals there are of each kind, the most first: the block's summary. */
const SignalKinds = ({ signals }: { signals: Signals }) => {
  const { t, i18n } = useLingui();
  const all = signals.improvement?.signals ?? [];
  if (all.length === 0) {
    return (
      <p className="text-muted-foreground">
        <Trans>Nothing to make better right now.</Trans>
      </p>
    );
  }
  return (
    <ul aria-label={t`Signals by kind`} className="flex flex-col">
      {signalKinds(all)
        .slice(0, kindsShown)
        .map(({ kind, count }) => (
          <li
            className="flex items-center gap-3 border-t py-2 first:border-t-0 first:pt-0"
            key={kind}
          >
            <ItemMark icon={signalKindLooks[kind].icon} />
            <span className="min-w-0 flex-1 truncate">
              {i18n._(signalKindLooks[kind].name)}
            </span>
            <span className="tabular-nums">{count}</span>
          </li>
        ))}
    </ul>
  );
};

/** Every signal with when they were last worked out: the full view. */
const SignalsInFull = ({ signals }: { signals: Signals }) => {
  const computed = signals.improvement?.computedAt ?? undefined;
  const date = computed === undefined ? undefined : formatDate(computed);
  const none = (signals.improvement?.signals.length ?? 0) === 0;
  return (
    <div className="flex flex-col gap-3">
      {date === undefined ? null : (
        <p className="text-muted-foreground">
          <Trans>Worked out daily, last on {date}.</Trans>
        </p>
      )}
      {none ? (
        <p className="text-muted-foreground">
          <Trans>Nothing to make better right now.</Trans>
        </p>
      ) : (
        <SignalList signals={signals} />
      )}
    </div>
  );
};

/**
 * Could be better, as a widget: its block counts the signals by kind, the
 * most first, and its full view lists every one. The block stands while
 * the signals are read again (after a dismiss, say), so its full view
 * stays open through it; only what is in it waits.
 */
export const CouldBeBetter = ({
  signals,
}: {
  signals: Promise<Loaded<Signals>>;
}) => {
  const { t } = useLingui();
  return (
    <WidgetBlock
      full={
        <Await fallback={<LoadingLines />} promise={signals}>
          {(loaded) =>
            loaded.state === "ready" ? (
              <SignalsInFull signals={loaded.data} />
            ) : (
              <NotLoaded page={loaded} />
            )
          }
        </Await>
      }
      title={t`Could be better`}
    >
      <Await fallback={<LoadingLines />} promise={signals}>
        {(loaded) =>
          loaded.state === "ready" ? (
            <SignalKinds signals={loaded.data} />
          ) : (
            <NotLoaded page={loaded} />
          )
        }
      </Await>
    </WidgetBlock>
  );
};
