import type {
  KnowledgeSignal,
  KnowledgeSignals,
} from "@grasp-os/shared/knowledge-signals";
import type {
  ImprovementSignal,
  ImprovementSignals,
} from "@grasp-os/shared/signals";
import { signalWindowDays } from "@grasp-os/shared/signals";
import { Button } from "@grasp-os/ui/components/button";
import { plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link, useRouter } from "@tanstack/react-router";
import {
  BookOpenIcon,
  CircleDollarSignIcon,
  ClockIcon,
  SearchXIcon,
  TriangleAlertIcon,
  UndoIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDate } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { AskToFix } from "../workflows/fix-in-chat.tsx";
import {
  DashboardCard,
  DashboardCardHeader,
  ItemMark,
} from "./dashboard-card.tsx";

// What could be better, from the signals core works out daily: workflows
// that keep failing, waiting or being corrected, what they cost, searches
// that found nothing, and Knowledge nobody reads or that is past its
// review. Each in plain words, with the counts core gives (never a score
// or a ranking), linking to what it is about, and "Ask Grasp" where a chat
// can help: asking the agent to fix a run that failed. Admins see every
// improvement signal, an engine's builders that engine's, and a
// collection's owners its Knowledge signals; someone with none sees no
// card.

/** What the dashboard read of the signals: each read on its own, none for someone it doesn't apply to. */
export interface Signals {
  improvement: ImprovementSignals | undefined;
  knowledge: KnowledgeSignals | undefined;
  /** Engine names by ID. */
  engines: ReadonlyMap<string, string>;
  /** The model a fix is asked with, if any. */
  model: string | undefined;
}

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
  icon,
  kind,
  children,
  action,
}: {
  icon: LucideIcon;
  kind: string;
  children: ReactNode;
  action?: ReactNode;
}) => (
  <li className="flex min-h-14 items-center gap-3 border-t px-4 py-2">
    <ItemMark icon={icon} />
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="text-muted-foreground text-xs">{kind}</span>
      <span>{children}</span>
    </div>
    {action}
  </li>
);

/** The workflow a signal is about, linking to it; its engine without one. */
const About = ({
  signal,
  engines,
}: {
  signal: ImprovementSignal;
  engines: ReadonlyMap<string, string>;
}) => {
  const { t } = useLingui();
  const { app, workflow } = signal;
  if (app === null) {
    return <span>{t`your organization`}</span>;
  }
  const engine = engines.get(app) ?? app;
  return workflow === null ? (
    <Link className="underline" params={{ engine: app }} to="/engines/$engine">
      {engine}
    </Link>
  ) : (
    <Link
      className="underline"
      params={{ app, workflow }}
      to="/workflows/$app/$workflow"
    >
      {workflow}
    </Link>
  );
};

const ImprovementRow = ({
  signal,
  engines,
  model,
}: {
  signal: ImprovementSignal;
  engines: ReadonlyMap<string, string>;
  model: string | undefined;
}) => {
  const { t, i18n } = useLingui();
  const about = <About engines={engines} signal={signal} />;
  const days = signalWindowDays;
  const step = signal.subject ?? "–";
  if (signal.kind === "waiting_for_person") {
    const { open } = signal.evidence;
    const waited = waitedFor(signal.value, t);
    return (
      <SignalRow icon={ClockIcon} kind={t`Waiting for a person`}>
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
    const [latest] = signal.evidence.recent ?? [];
    return (
      <SignalRow
        action={
          latest === undefined || model === undefined ? undefined : (
            <AskToFix model={model} run={latest} />
          )
        }
        icon={TriangleAlertIcon}
        kind={t`Keeps failing`}
      >
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
      <SignalRow icon={UndoIcon} kind={t`Often corrected`}>
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
      <SignalRow icon={CircleDollarSignIcon} kind={t`Model cost`}>
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
    <SignalRow icon={SearchXIcon} kind={t`Unanswered question`}>
      <Trans>
        A Knowledge search from {about} found nothing{" "}
        <Plural one="once" other="# times" value={searches} />, by{" "}
        <Plural one="# asker" other="# askers" value={askers} />.
      </Trans>
    </SignalRow>
  );
};

/** Dismissing a Knowledge signal until something new comes, as its owner can. */
const Dismiss = ({ id, label }: { id: string; label: string }) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        aria-label={label}
        disabled={busy}
        onClick={() => {
          void (async () => {
            await run(async (session) => {
              await session.knowledgeSignals.dismiss(id);
            });
            await router.invalidate();
          })();
        }}
        size="xs"
        variant="ghost"
      >
        <Trans context="put a signal away until something new">Dismiss</Trans>
      </Button>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

const KnowledgeRow = ({ signal }: { signal: KnowledgeSignal }) => {
  const { t } = useLingui();
  const { collection } = signal;
  const where = (
    <Link
      className="underline"
      params={{ collection: collection.id }}
      search={{}}
      to="/knowledge/$collection"
    >
      {collection.name}
    </Link>
  );
  const { name } = collection;
  const dismiss = (
    <Dismiss id={signal.id} label={t`Dismiss this signal about ${name}`} />
  );
  if (signal.kind === "unanswered_question") {
    const { searches, askers } = signal.evidence;
    return (
      <SignalRow
        action={dismiss}
        icon={SearchXIcon}
        kind={t`Unanswered question`}
      >
        <Trans>
          A search in {where} found nothing{" "}
          <Plural one="once" other="# times" value={searches} />, by{" "}
          <Plural one="# asker" other="# askers" value={askers} />.
        </Trans>
      </SignalRow>
    );
  }
  const { document } = signal.evidence;
  const doc = (
    <Link
      className="underline"
      params={{ collection: collection.id }}
      search={{ doc: document.id }}
      to="/knowledge/$collection"
    >
      {document.title}
    </Link>
  );
  if (signal.kind === "unread_document") {
    const { days } = signal.evidence;
    return (
      <SignalRow action={dismiss} icon={BookOpenIcon} kind={t`Nobody reads it`}>
        <Trans>
          Nobody read or changed {doc} in {where} in the last{" "}
          <Plural one="day" other="# days" value={days} />.
        </Trans>
      </SignalRow>
    );
  }
  const late = signal.value;
  return (
    <SignalRow action={dismiss} icon={ClockIcon} kind={t`Review overdue`}>
      <Trans>
        {doc} in {where} is <Plural one="# day" other="# days" value={late} />{" "}
        past its review date.
      </Trans>
    </SignalRow>
  );
};

/** When the signals were last worked out: the later of the two. */
const computedOf = ({
  improvement,
  knowledge,
}: Signals): string | undefined => {
  const at = [improvement?.computedAt, knowledge?.computedAt].filter(
    (time): time is string => typeof time === "string"
  );
  return at.toSorted().at(-1);
};

/** Could be better: hidden for someone with no signals. */
export const CouldBeBetter = ({ signals }: { signals: Signals }) => {
  const { t } = useLingui();
  const improvement = signals.improvement?.signals ?? [];
  const knowledge = signals.knowledge?.signals ?? [];
  const count = improvement.length + knowledge.length;
  if (count === 0) {
    return null;
  }
  const computed = computedOf(signals);
  const date = computed === undefined ? undefined : formatDate(computed);
  return (
    <DashboardCard id="dashboard-signals">
      <DashboardCardHeader
        count={count}
        id="dashboard-signals"
        note={
          date === undefined ? undefined : t`Worked out daily, last on ${date}`
        }
        title={t`Could be better`}
      />
      <ul aria-label={t`Could be better`}>
        {improvement.map((signal) => (
          <ImprovementRow
            engines={signals.engines}
            key={`${signal.kind}:${signal.app ?? ""}:${signal.workflow ?? ""}:${signal.subject ?? ""}`}
            model={signals.model}
            signal={signal}
          />
        ))}
        {knowledge.map((signal) => (
          <KnowledgeRow key={signal.id} signal={signal} />
        ))}
      </ul>
    </DashboardCard>
  );
};
