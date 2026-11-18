import type {
  KnowledgeSignal,
  KnowledgeSignals,
} from "@grasp-os/shared/knowledge-signals";
import type {
  ImprovementSignal,
  ImprovementSignals,
} from "@grasp-os/shared/signals";
import { signalWindowDays } from "@grasp-os/shared/signals";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Await, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDate } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { RouterLink } from "../frame/router-link.tsx";
import { Button } from "../grasp/button/index.ts";
import { iconVars } from "../grasp/icons/icon.stylex.ts";
import {
  Alert,
  Clock,
  Doc,
  Icon,
  Money,
  Search,
  Undo,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
} from "../grasp/item/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { signalKinds } from "./board.ts";
import type { SignalKind } from "./board.ts";
import { WidgetBlock } from "./widget-block.tsx";

// What could be better, from the signals core works out daily: workflows
// that keep failing, waiting or being corrected, what they cost, searches
// that found nothing, and Knowledge nobody reads or that is past its
// review. Each in plain words, with the counts core gives (never a score
// or a ranking), linking to what it is about, and "Ask Grasp" where a chat
// can help: asking the agent to fix a run that failed. Admins see every
// improvement signal, an App's builders that App's, and a
// collection's owners its Knowledge signals; someone with none to see has
// no widget. On the dashboard's widget board, its block counts the
// signals by kind, and its full view lists every one.

const styles = stylex.create({
  // The full view's list stands in one frame, a line between its rows.
  frame: {
    overflow: "hidden",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    boxShadow: grasp.edge,
  },
  dismiss: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    rowGap: grasp.space1,
  },
  kinds: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  kind: {
    display: "flex",
    alignItems: "center",
    columnGap: grasp.space3,
    paddingBlockStart: { default: grasp.space2, ":first-child": 0 },
    paddingBlockEnd: grasp.space2,
    borderTopWidth: { default: grasp.hairline, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
  },
  // A kind's mark: its icon in a small square, as an Item's.
  mark: {
    [iconVars.size]: grasp.iconSm,
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    width: grasp.controlSm,
    height: grasp.controlSm,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.quietFill,
    boxShadow: grasp.edge,
    color: grasp.muted,
  },
  kindName: { flexGrow: 1, minWidth: 0 },
  count: { fontVariantNumeric: "tabular-nums" },
  inFull: { display: "flex", flexDirection: "column", rowGap: grasp.space3 },
});

/** What the dashboard read of the signals: each read on its own, none for someone it doesn't apply to. */
export interface Signals {
  improvement: ImprovementSignals | undefined;
  knowledge: KnowledgeSignals | undefined;
  /** App names by ID. */
  appNames: ReadonlyMap<string, string>;
}

/** Each kind of signal's mark and name, as its rows and the block's counts show them. */
export const signalKindLooks: Record<
  SignalKind,
  { icon: IconData; name: MessageDescriptor }
> = {
  failing_step: { icon: Alert, name: msg`Keeps failing` },
  waiting_for_person: { icon: Clock, name: msg`Waiting for a person` },
  correction: { icon: Undo, name: msg`Often corrected` },
  cost_per_run: { icon: Money, name: msg`Model cost` },
  unanswered_question: { icon: Search, name: msg`Unanswered question` },
  unread_document: { icon: Doc, name: msg`Nobody reads it` },
  overdue_review: { icon: Clock, name: msg`Review overdue` },
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
    <Item size="sm">
      <ItemMedia icon={icon} />
      <ItemContent>
        <Text element="span" size="xs" tone="muted">
          {i18n._(name)}
        </Text>
        <Text element="span">{children}</Text>
      </ItemContent>
      {action === undefined ? null : <ItemActions>{action}</ItemActions>}
    </Item>
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
    <RouterLink params={{ app }} to="/apps/$app">
      {name}
    </RouterLink>
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

/** Dismissing a Knowledge signal until something new comes, as its owner can. */
const Dismiss = ({ id, label }: { id: string; label: string }) => {
  const router = useRouter();
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  return (
    <div {...stylex.props(styles.dismiss)}>
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
        {t({
          message: "Dismiss",
          context: "put a signal away until something new",
        })}
      </Button>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

const KnowledgeRow = ({ signal }: { signal: KnowledgeSignal }) => {
  const { t } = useLingui();
  const { collection } = signal;
  const where = (
    <RouterLink
      params={{ collection: collection.id }}
      search={{}}
      to="/knowledge/$collection"
    >
      {collection.name}
    </RouterLink>
  );
  const { name } = collection;
  const dismiss = (
    <Dismiss id={signal.id} label={t`Dismiss this signal about ${name}`} />
  );
  if (signal.kind === "unanswered_question") {
    const { searches, askers } = signal.evidence;
    return (
      <SignalRow action={dismiss} kind="unanswered_question">
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
    <RouterLink
      params={{ collection: collection.id }}
      search={{ doc: document.id }}
      to="/knowledge/$collection"
    >
      {document.title}
    </RouterLink>
  );
  if (signal.kind === "unread_document") {
    const { days } = signal.evidence;
    return (
      <SignalRow action={dismiss} kind="unread_document">
        <Trans>
          Nobody read or changed {doc} in {where} in the last{" "}
          <Plural one="day" other="# days" value={days} />.
        </Trans>
      </SignalRow>
    );
  }
  const late = signal.value;
  return (
    <SignalRow action={dismiss} kind="overdue_review">
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

/** How many kinds the block counts at most; the full view has them all. */
const kindsShown = 4;

/** Every signal, one row each, with what can be done about it. */
const SignalList = ({ signals }: { signals: Signals }) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.frame)}>
      <ItemGroup aria-label={t`Could be better`} separated>
        {signals.improvement?.signals.map((signal) => (
          <ImprovementRow
            appNames={signals.appNames}
            key={`${signal.kind}:${signal.app ?? ""}:${signal.workflow ?? ""}:${signal.subject ?? ""}`}
            signal={signal}
          />
        ))}
        {signals.knowledge?.signals.map((signal) => (
          <KnowledgeRow key={signal.id} signal={signal} />
        ))}
      </ItemGroup>
    </div>
  );
};

/** How many signals there are of each kind, the most first: the block's summary. */
const SignalKinds = ({ signals }: { signals: Signals }) => {
  const { t, i18n } = useLingui();
  const all = [
    ...(signals.improvement?.signals ?? []),
    ...(signals.knowledge?.signals ?? []),
  ];
  if (all.length === 0) {
    return (
      <Text tone="muted">
        <Trans>Nothing to make better right now.</Trans>
      </Text>
    );
  }
  return (
    <ul aria-label={t`Signals by kind`} {...stylex.props(styles.kinds)}>
      {signalKinds(all)
        .slice(0, kindsShown)
        .map(({ kind, count }) => (
          <li key={kind} {...stylex.props(styles.kind)}>
            <span aria-hidden="true" {...stylex.props(styles.mark)}>
              <Icon icon={signalKindLooks[kind].icon} />
            </span>
            <Text
              element="span"
              layout={styles.kindName}
              size="sm"
              wrap="truncate"
            >
              {i18n._(signalKindLooks[kind].name)}
            </Text>
            <span {...stylex.props(styles.count)}>{count}</span>
          </li>
        ))}
    </ul>
  );
};

/** Every signal with when they were last worked out: the full view. */
const SignalsInFull = ({ signals }: { signals: Signals }) => {
  const computed = computedOf(signals);
  const date = computed === undefined ? undefined : formatDate(computed);
  const none =
    (signals.improvement?.signals.length ?? 0) +
      (signals.knowledge?.signals.length ?? 0) ===
    0;
  return (
    <div {...stylex.props(styles.inFull)}>
      {date === undefined ? null : (
        <Text tone="muted">
          <Trans>Worked out daily, last on {date}.</Trans>
        </Text>
      )}
      {none ? (
        <Text tone="muted">
          <Trans>Nothing to make better right now.</Trans>
        </Text>
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
