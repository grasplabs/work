/**
 * How a client's Brain is doing, for Grasp's staff (GRA-1733): its work
 * queue, its store's size against its limit, its erasure ledger and the
 * steps of its tick that failed, as its core reported it as the section
 * opened (src/clients/brain.ts), with its embedding's progress and how
 * its recall does by each way since its store started, and what its
 * model calls spent this month by purpose, as the model gateway recorded
 * them; and the
 * three things staff may do: put a parked item back in the queue, rebuild
 * the word indexes, and re-embed; and whether one source or person was
 * erased (brain-erasure-lookup.tsx). Every read, action and lookup is in
 * the company's audit log, by the staff member.
 *
 * Operational state only: counts, ages, kinds of work, error codes,
 * sizes, recall's counts, erasures as counts alone, and each synced
 * connection by a hash of it (GRA-1817). Amber marks what
 * needs someone: parked items, a store near its limit, a ledger that
 * isn't read through, a step that failed, a way of recall that failed.
 * What is fine is said in a line or folded: the queue's one kind, upkeep
 * that got through, the erasure counters, and the engine's rebuilds.
 */

import {
  brainSearchWays,
  brainSteps,
  brainWithoutMeaningReasons,
  storeNearLimit,
} from "@grasp-os/shared/brain-report";
import type {
  BrainAction,
  BrainActionOutcome,
  BrainReport,
  BrainSearchWay,
  BrainStep,
  BrainSyncConnection,
  BrainSyncPhase,
  BrainWithoutMeaningReason,
} from "@grasp-os/shared/brain-report";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { ItemGroup } from "@grasp-os/ui/components/item";
import { StatGroup } from "@grasp-os/ui/components/stat";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Await, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { brainActionFn } from "../clients/brain-functions.ts";
import { thenRefresh } from "../use-action.ts";
import { agoWords } from "./ai-status-words.ts";
import { BrainErasureLookupSection } from "./brain-erasure-lookup.tsx";
import type { BrainRead } from "./brain-loads.ts";
import { EmptyPart, PagePart } from "./page-part.tsx";
import { PartRow, PartRows } from "./part-rows.tsx";
import {
  dollars,
  formatList,
  formatMonth,
  formatPercent,
  plural,
  tokens,
  whole,
} from "./words.ts";

const styles = stylex.create({
  figure: { fontVariantNumeric: "tabular-nums" },
  muted: { color: colors.mutedForeground },
  // A cell of two lines: what it is, and a quiet line under it.
  lines: { display: "flex", flexDirection: "column", gap: "2px" },
  // The same, its lines at the cell's end.
  linesEnd: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: space["1"],
  },
  small: { fontSize: font.textXs, color: colors.mutedForeground },
  mono: { fontFamily: font.mono, fontSize: font.textXs },
  // A row's badge beside its button.
  pair: { display: "flex", alignItems: "center", gap: space["3"] },
});

/**
 * Rows folded under a panel's Details, edge to edge as its other rows. Kept
 * on the page while folded: found by the page's search.
 */
const FoldedRows = ({ children }: { children: ReactNode }) => (
  <CollapsibleContent asChild>
    <div>
      <ItemGroup separated>{children}</ItemGroup>
    </div>
  </CollapsibleContent>
);

/** What an action did, as staff read it: its kind's line when done. */
const doneWords: Readonly<Record<BrainAction["type"], string>> = {
  requeue: "The item is back in the queue: it runs at the next tick.",
  rebuild_words:
    "The word indexes are being rebuilt, a batch a minute; recall goes on meanwhile.",
  reembed:
    "The embedding's rebuild started over: passages without vectors go back on the queue.",
};

/** What an action that changed nothing answered, as staff read it. */
const notDoneWords: Readonly<
  Record<Exclude<BrainActionOutcome, "done"> | "not_answered", string>
> = {
  nothing:
    "Nothing to do: the item isn't parked any more, a rebuild of the word indexes is under way already, or no embedding model runs.",
  unavailable:
    "The Brain is reading its erasure ledger and takes nothing else yet: try again shortly.",
  not_answered: "The company's Grasp didn't answer: try again.",
};

/** What staff read when the action failed otherwise. */
const failedWords = "That didn't work: try again.";

/** The line an action leaves, and whether it says something went wrong. */
interface Said {
  text: string;
  wrong: boolean;
}

/** The line `outcome` of `action` leaves. */
const saidOf = (
  action: BrainAction,
  outcome: BrainActionOutcome | "not_answered"
): Said =>
  outcome === "done"
    ? { text: doneWords[action.type], wrong: false }
    : { text: notDoneWords[outcome], wrong: outcome !== "nothing" };

const replayWords: Record<BrainReport["ledger"]["replay"], string> = {
  through: "Read through",
  replaying: "Replaying after a restore",
  unreadable: "Can't be read",
};

const stepWords: Record<BrainStep, string> = {
  ledger: "Writing erasures to the ledger",
  erase: "Deleting what erasures hid",
  sweep: "Sweeping files nothing holds",
  repack: "Repacking vector codes",
  reindex: "Rebuilding the word indexes",
  quotes: "Judging memories against their sources",
  embedding: "Putting passages on the queue to embed",
};

const wayWords: Record<BrainSearchWay, string> = {
  words: "Words",
  exact: "Exact parts",
  entities: "Entities",
  meaning: "Meaning",
};

const withoutMeaningWords: Record<BrainWithoutMeaningReason, string> = {
  timed_out: "timed out",
  failed: "failed",
  refused: "refused",
  unusable: "unusable",
};

const reasonOrder = [
  "deleted",
  "retention",
  "person_erased",
  "withdrawn",
] as const;

const reasonWords: Record<(typeof reasonOrder)[number], string> = {
  deleted: "deleted for good",
  retention: "past their retention",
  person_erased: "people erased",
  withdrawn: "withdrawn",
};

const pauseWords: Record<string, string> = {
  rate_limited: "the model is limiting its calls",
  unavailable: "the model doesn't answer",
  account: "the model's account refuses calls",
};

const oneDecimal = new Intl.NumberFormat("en", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Bytes in GB or MB, as Cloudflare counts them (10^9, 10^6). */
const sizeWords = (bytes: number): string =>
  bytes >= 1e9
    ? `${oneDecimal.format(bytes / 1e9)} GB`
    : `${oneDecimal.format(bytes / 1e6)} MB`;

/**
 * Runs `action` on the Brain, then reads the section again. Held above
 * the report, so what the action answered stays shown while the report
 * is read again, and when the part that asked is gone from it (the last
 * parked item, say).
 */
const useBrainAction = (clientId: string) => {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const act = (action: BrainAction) => {
    setBusy(true);
    setSaid(null);
    void (async () => {
      let next: Said = { text: failedWords, wrong: true };
      try {
        const { outcome } = await thenRefresh(
          async () => await brainActionFn({ data: { clientId, action } }),
          async () => {
            await router.invalidate({ sync: true });
          }
        );
        next = saidOf(action, outcome);
      } catch {
        // Said as failed: nothing of the error is for staff.
      }
      setSaid(next);
      setBusy(false);
    })();
  };
  return { busy, said, act };
};

/** What staff may do to the Brain, as the report's parts are given it. */
interface Acting {
  busy: boolean;
  act: (action: BrainAction) => void;
}

/** In how long `at` comes after `now`, in a few words: "in 5 min". */
const inWords = (at: number, now: number): string => {
  const minutes = Math.max(1, Math.ceil((at - now) / 60_000));
  if (minutes < 60) {
    return `in ${whole(minutes)} min`;
  }
  const hours = Math.round(minutes / 60);
  return `in ${whole(hours)} ${plural(hours, "hour", "hours")}`;
};

/** The figures first: what waits, what is parked, the store and the ledger. */
const Figures = ({ report }: { report: BrainReport }) => {
  const now = Date.parse(report.now);
  const { queue, store, ledger } = report;
  const waiting = queue.waiting.reduce((sum, { count }) => sum + count, 0);
  const oldest = Math.min(
    ...queue.waiting.map(({ oldestAddedAt }) => Date.parse(oldestAddedAt))
  );
  const near = storeNearLimit(store);
  // One kind of work has no table of its own (`Waiting`): the tile names it.
  const [only] = queue.waiting.length === 1 ? queue.waiting : [];
  const kind = only === undefined ? "" : `${only.kind}: `;
  return (
    <StatGroup
      aria-label="The Brain at work"
      items={[
        {
          label: "Waiting",
          value: whole(waiting),
          change:
            waiting === 0
              ? `${whole(queue.running)} running`
              : `${kind}oldest added ${agoWords(oldest, now)}, ${whole(queue.running)} running`,
        },
        {
          label: "Parked",
          value: whole(queue.parkedCount),
          ...(queue.parkedCount > 0
            ? {
                change:
                  "Failed too often: requeue below once the cause is fixed",
                variant: "warning" as const,
              }
            : {}),
        },
        {
          label: "Store",
          value: sizeWords(store.bytes),
          change: near
            ? `Near its limit of ${sizeWords(store.limitBytes)}: writes fail once it is full`
            : `${formatPercent(store.bytes / store.limitBytes)} of ${sizeWords(store.limitBytes)}`,
          variant: near ? "warning" : "default",
        },
        {
          label: "Erasure ledger",
          value: replayWords[ledger.replay],
          ...(ledger.replay === "through"
            ? {}
            : {
                change: "The Brain answers nothing until it is read through",
                variant: "warning" as const,
              }),
        },
      ]}
    />
  );
};

/**
 * What waits, kind by kind, once there is more than one kind (one alone
 * is the tile's own number), and whether the queue waits for its model.
 */
const Waiting = ({ report }: { report: BrainReport }) => {
  const now = Date.parse(report.now);
  const { queue } = report;
  const pause = queue.paused;
  const kinds = queue.waiting.length > 1;
  if (pause === null && queue.overdue === 0 && !kinds) {
    return null;
  }
  return (
    <PagePart title="Queue">
      {pause === null && queue.overdue === 0 ? null : (
        <PartRows>
          {pause === null ? null : (
            <PartRow
              description={`Since ${agoWords(Date.parse(pause.since), now)}: ${pauseWords[pause.reason] ?? pause.reason}. It tries again ${inWords(Date.parse(pause.until), now)}.`}
              label="Waiting for the model"
            >
              <Badge variant="warning">Paused</Badge>
            </PartRow>
          )}
          {queue.overdue > 0 ? (
            <PartRow
              description="Their handlers ran past their time and still hold a slot each."
              label="Running past their time"
            >
              <Badge variant="warning">{whole(queue.overdue)}</Badge>
            </PartRow>
          ) : null}
        </PartRows>
      )}
      {kinds ? (
        <Table aria-label="Waiting by kind">
          <TableHeader>
            <TableRow>
              <TableHead>Kind</TableHead>
              <TableHead align="end">Waiting</TableHead>
              <TableHead align="end">Oldest added</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {queue.waiting.map(({ kind, count, oldestAddedAt }) => (
              <TableRow key={kind}>
                <TableCell>
                  <span {...stylex.props(styles.figure)}>{kind}</span>
                </TableCell>
                <TableCell align="end">
                  <span {...stylex.props(styles.figure)}>{whole(count)}</span>
                </TableCell>
                <TableCell align="end">
                  {agoWords(Date.parse(oldestAddedAt), now)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </PagePart>
  );
};

/** The parked items, the latest first, each with its error and a requeue. */
const Parked = ({
  acting: { busy, act },
  report,
}: {
  acting: Acting;
  report: BrainReport;
}) => {
  const now = Date.parse(report.now);
  const { parked, parkedCount } = report.queue;
  if (parkedCount === 0) {
    return null;
  }
  const shown =
    parked.length < parkedCount
      ? ` The latest ${whole(parked.length)} of ${whole(parkedCount)} show.`
      : "";
  return (
    <PagePart
      description={`Items that failed too often. Each comes back by itself a day later, up to three times; requeue one to run it now.${shown}`}
      title="Parked"
    >
      <Table aria-label="Parked items">
        <TableHeader>
          <TableRow>
            <TableHead>Kind</TableHead>
            <TableHead>Last error</TableHead>
            <TableHead align="end">Attempts</TableHead>
            <TableHead align="end">Parked</TableHead>
            <TableHead align="end" aria-label="Requeue" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {parked.map((item) => (
            <TableRow key={item.item}>
              <TableCell>
                <span {...stylex.props(styles.figure)}>{item.kind}</span>
              </TableCell>
              <TableCell wrap>
                <span {...stylex.props(styles.lines)}>
                  <span>{item.message}</span>
                  <span {...stylex.props(styles.small)}>{item.error}</span>
                </span>
              </TableCell>
              <TableCell align="end">
                <span {...stylex.props(styles.figure)}>
                  {whole(item.attempts)}
                </span>
              </TableCell>
              <TableCell align="end">
                <span {...stylex.props(styles.linesEnd)}>
                  <span>{agoWords(Date.parse(item.parkedAt), now)}</span>
                  {item.final ? (
                    <Badge variant="warning">For good</Badge>
                  ) : (
                    <span {...stylex.props(styles.small)}>
                      {`${whole(item.parks)} ${plural(item.parks, "time", "times")}`}
                    </span>
                  )}
                </span>
              </TableCell>
              <TableCell align="end">
                <Button
                  disabled={busy}
                  onClick={() => {
                    act({ type: "requeue", item: item.item });
                  }}
                  size="sm"
                  variant="outline"
                >
                  Requeue
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </PagePart>
  );
};

/**
 * The Brain's engine, folded: its word indexes and its embedding, with
 * the rebuild of each, which staff rarely need. Open by itself while
 * either is being rebuilt.
 */
const Engine = ({
  acting: { busy, act },
  report,
}: {
  acting: Acting;
  report: BrainReport;
}) => {
  const { embedding } = report;
  const rebuilding = report.words === "rebuilding";
  return (
    <Collapsible defaultOpen={rebuilding || embedding.rebuilding}>
      <PagePart
        action={
          <CollapsibleTrigger asChild>
            <Button size="sm" variant="outline">
              Details
            </Button>
          </CollapsibleTrigger>
        }
        description="Its word indexes and its embedding, and the rebuild of each."
        title="Engine"
      >
        <FoldedRows>
          <PartRow
            description="What recall finds words by. A rebuild rewrites every passage's words from its text, 200 a minute; recall goes on meanwhile."
            label="Word indexes"
          >
            <span {...stylex.props(styles.pair)}>
              {rebuilding ? (
                <Badge>Rebuilding</Badge>
              ) : (
                <Badge variant="success">Current</Badge>
              )}
              <Button
                disabled={busy || rebuilding}
                onClick={() => {
                  act({ type: "rebuild_words" });
                }}
                size="sm"
                variant="outline"
              >
                Rebuild
              </Button>
            </span>
          </PartRow>
          {embedding.model === null ? (
            <PartRow label="Embedding">
              <span {...stylex.props(styles.muted)}>
                No embedding model runs yet, so the Brain recalls by words
                alone.
              </span>
            </PartRow>
          ) : (
            [
              <PartRow key="model" label="Embedding model">
                <span {...stylex.props(styles.figure)}>{embedding.model}</span>
              </PartRow>,
              <PartRow key="embedded" label="Embedded">
                <span {...stylex.props(styles.figure)}>
                  {`${whole(embedding.embedded)} of ${whole(embedding.chunks)} ${plural(embedding.chunks, "passage", "passages")}`}
                </span>
              </PartRow>,
              <PartRow
                description="Passages the model can't embed: found by words only, until a re-embed."
                key="passed"
                label="Passed over"
              >
                <span {...stylex.props(styles.figure)}>
                  {whole(embedding.passedOver)}
                </span>
              </PartRow>,
              <PartRow
                key="rebuild"
                description={
                  embedding.rebuilding && report.queue.parkedCount > 0
                    ? "It waits on what it put on the queue, parked items included: see Parked above. Once the embedders work again, re-embed to put them back now."
                    : "A re-embed puts every passage without its vectors back on the queue, those passed over included."
                }
                label="Embedding's rebuild"
              >
                <span {...stylex.props(styles.pair)}>
                  {embedding.rebuilding ? (
                    <Badge>Under way</Badge>
                  ) : (
                    <Badge variant="success">Done</Badge>
                  )}
                  <Button
                    disabled={busy}
                    onClick={() => {
                      act({ type: "reembed" });
                    }}
                    size="sm"
                    variant="outline"
                  >
                    Re-embed
                  </Button>
                </span>
              </PartRow>,
            ]
          )}
        </FoldedRows>
      </PagePart>
    </Collapsible>
  );
};

/** How recall did by each way, and how often it went without meaning. */
const Recall = ({ report }: { report: BrainReport }) => {
  const { recall } = report;
  return (
    <PagePart
      description={`Since the store last started, ${agoWords(Date.parse(recall.since), Date.parse(report.now))}. A recall searches by each way the question has something for.`}
      title="Recall"
    >
      <Table aria-label="Recall by each way">
        <TableHeader>
          <TableRow>
            <TableHead>Way</TableHead>
            <TableHead align="end">Recalls</TableHead>
            <TableHead align="end">Failed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {brainSearchWays.map((way) => {
            const counts = recall.ways[way];
            if (counts === undefined) {
              // A core of an older release, on a slower channel, doesn't send it.
              return (
                <TableRow key={way}>
                  <TableCell>{wayWords[way]}</TableCell>
                  <TableCell align="end" colSpan={2}>
                    Not available yet
                  </TableCell>
                </TableRow>
              );
            }
            return (
              <TableRow key={way}>
                <TableCell>{wayWords[way]}</TableCell>
                <TableCell align="end">
                  <span {...stylex.props(styles.figure)}>
                    {whole(counts.recalls)}
                  </span>
                </TableCell>
                <TableCell align="end">
                  {counts.failed > 0 ? (
                    <Badge variant="warning">{whole(counts.failed)}</Badge>
                  ) : (
                    <span {...stylex.props(styles.figure)}>0</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <PartRows>
        <PartRow
          description="Recalls that went by words and exact parts alone because the embedding model failed, was too slow or had no files, or gave a vector the Brain couldn't use."
          label="Without meaning"
        >
          <span {...stylex.props(styles.figure)}>
            {formatList(
              brainWithoutMeaningReasons.map(
                (reason) =>
                  `${whole(recall.withoutMeaning[reason])} ${withoutMeaningWords[reason]}`
              )
            )}
          </span>
        </PartRow>
      </PartRows>
    </PagePart>
  );
};

/**
 * What the Brain's model calls spent this month, by purpose, as the
 * model gateway recorded each answered request. An overview: nothing
 * limits it.
 */
const ModelSpend = ({ report }: { report: BrainReport }) => {
  const spend = report.modelSpend;
  if (spend === undefined) {
    // A core of an older release, on a slower channel, doesn't send it.
    return (
      <PagePart title="Model spend">
        <PartRows>
          <PartRow label="Not available yet">
            <span>This client’s release doesn’t report model spend yet.</span>
          </PartRow>
        </PartRows>
      </PagePart>
    );
  }
  const month = formatMonth(spend.month);
  return (
    <PagePart
      description={`${month}, as the model gateway recorded each answered call, at the providers’ list prices: on the client’s own keys, their provider’s invoice is the bill.`}
      title="Model spend"
    >
      {spend.purposes.length === 0 ? (
        <PartRows>
          <PartRow label={`No model calls in ${month}`}>
            <span {...stylex.props(styles.figure)}>{dollars(0)}</span>
          </PartRow>
        </PartRows>
      ) : (
        <Table aria-label="Model spend by purpose">
          <TableHeader>
            <TableRow>
              <TableHead>Purpose</TableHead>
              <TableHead align="end">Calls</TableHead>
              <TableHead align="end">Tokens in</TableHead>
              <TableHead align="end">Tokens out</TableHead>
              <TableHead align="end">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {spend.purposes.map((used) => (
              <TableRow key={used.purpose}>
                <TableCell>
                  <code>{used.purpose}</code>
                </TableCell>
                <TableCell align="end">
                  <span {...stylex.props(styles.figure)}>
                    {whole(used.calls)}
                  </span>
                </TableCell>
                <TableCell align="end">
                  <span {...stylex.props(styles.figure)}>
                    {tokens(used.inputTokens)}
                  </span>
                </TableCell>
                <TableCell align="end">
                  <span {...stylex.props(styles.figure)}>
                    {tokens(used.outputTokens)}
                  </span>
                </TableCell>
                <TableCell align="end">
                  <span {...stylex.props(styles.figure)}>
                    {dollars(used.cost)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PagePart>
  );
};

/**
 * The erasure ledger in one line, its counters under it: by kind, by
 * reason, and not yet written. Open by itself while an entry is still
 * to write.
 */
const Ledger = ({ report }: { report: BrainReport }) => {
  const { ledger } = report;
  const { unwritten } = ledger.source;
  return (
    <Collapsible defaultOpen={unwritten > 0}>
      <PagePart
        action={
          <CollapsibleTrigger asChild>
            <Button size="sm" variant="outline">
              Details
            </Button>
          </CollapsibleTrigger>
        }
        description="Every erasure, counted: never which, or when."
        title="Erasures"
      >
        <PartRows>
          <PartRow
            description="Erased sources, whole, with their ledger entry written."
            label="In the ledger"
          >
            <span {...stylex.props(styles.pair)}>
              {unwritten > 0 ? (
                <Badge variant="warning">
                  {`${whole(unwritten)} not yet written`}
                </Badge>
              ) : null}
              <span {...stylex.props(styles.figure)}>
                {`${whole(ledger.source.written)} ${plural(ledger.source.written, "source", "sources")}`}
              </span>
            </span>
          </PartRow>
        </PartRows>
        <FoldedRows>
          <PartRow
            description="Erased and hidden, their ledger entry still to write: each tick tries again."
            label="Not yet written"
          >
            <span {...stylex.props(styles.figure)}>{whole(unwritten)}</span>
          </PartRow>
          <PartRow
            description="Hidden already; the tick deletes what they held a batch at a time."
            label="Still being deleted"
          >
            <span {...stylex.props(styles.figure)}>
              {whole(ledger.erasing)}
            </span>
          </PartRow>
          <PartRow
            description="Sources with versions kept but none current, so nobody can read them: what a replay can leave."
            label="Sources without a current version"
          >
            <span {...stylex.props(styles.figure)}>
              {whole(ledger.sourcesWithoutCurrent)}
            </span>
          </PartRow>
          <PartRow label="By reason">
            <span {...stylex.props(styles.figure)}>
              {formatList(
                reasonOrder.map(
                  (reason) =>
                    `${whole(ledger.byReason[reason])} ${reasonWords[reason]}`
                )
              )}
            </span>
          </PartRow>
        </FoldedRows>
      </PagePart>
    </Collapsible>
  );
};

/** The tick's own steps that failed since the store started, or one line when none did. */
const Steps = ({ report }: { report: BrainReport }) => {
  const now = Date.parse(report.now);
  const failing = brainSteps.flatMap((step) => {
    // Not reported (undefined) by a core of an older release: nothing.
    const failed = report.stepsFailed[step];
    return failed === null || failed === undefined ? [] : [{ step, failed }];
  });
  return (
    <PagePart
      description={
        failing.length > 0
          ? "A failure shows until a later tick gets through."
          : undefined
      }
      title="Upkeep"
    >
      <PartRows>
        {failing.length === 0 ? (
          <PartRow label="Every step of its upkeep got through">
            <Badge variant="success">Fine</Badge>
          </PartRow>
        ) : (
          failing.map(({ step, failed }) => (
            <PartRow key={step} label={stepWords[step]}>
              <Badge variant="warning">
                {`${failed.reason === "timed_out" ? "Timed out" : "Failed"} ${agoWords(Date.parse(failed.at), now)}`}
              </Badge>
            </PartRow>
          ))
        )}
      </PartRows>
    </PagePart>
  );
};

/**
 * People's own stores, what one person alone may read: totals across
 * them, as each last told its core when its own upkeep ran. Never a
 * store, never a person.
 */
const OwnStores = ({ report }: { report: BrainReport }) => {
  const now = Date.parse(report.now);
  const own = report.ownStores;
  const description =
    "What one person alone may read is kept in a store of their own, which runs its own upkeep. Totals across them only: never which person.";
  if (own === undefined) {
    // A core of an older release, on a slower channel, doesn't send them.
    return (
      <PagePart description={description} title="People's own stores">
        <PartRows>
          <PartRow label="Not available yet">
            <span>
              This client’s release doesn’t report people’s own stores yet.
            </span>
          </PartRow>
        </PartRows>
      </PagePart>
    );
  }
  const people = `${whole(own.stores)} ${plural(own.stores, "person", "people")}`;
  return (
    <PagePart description={description} title="People's own stores">
      <PartRows>
        <PartRow
          description="Stores holding anything, as their own upkeep last found them."
          label="Stores"
        >
          <span {...stylex.props(styles.figure)}>{people}</span>
        </PartRow>
        <PartRow
          description={
            own.oldestWaitingAt === null
              ? undefined
              : `Oldest added ${agoWords(Date.parse(own.oldestWaitingAt), now)}.`
          }
          label="Waiting"
        >
          <span {...stylex.props(styles.figure)}>{whole(own.waiting)}</span>
        </PartRow>
        <PartRow
          description="Failed too often in someone's store; they come back by themselves unless parked for good."
          label="Parked"
        >
          {own.parked > 0 ? (
            <Badge variant="warning">{whole(own.parked)}</Badge>
          ) : (
            <span {...stylex.props(styles.figure)}>{whole(own.parked)}</span>
          )}
        </PartRow>
        <PartRow
          description="Stores whose last upkeep failed a step, waits for the model, or hasn't read its erasure ledger through."
          label="Failing"
        >
          {own.failing > 0 ? (
            <Badge variant="warning">{whole(own.failing)}</Badge>
          ) : (
            <Badge variant="success">None</Badge>
          )}
        </PartRow>
        <PartRow
          description="Stores whose passages aren't all embedded by the current model yet."
          label="Embedding not done"
        >
          <span {...stylex.props(styles.figure)}>{whole(own.notRebuilt)}</span>
        </PartRow>
        <PartRow
          description="Stores near what one store holds: writes fail once one is full."
          label="Near the limit"
        >
          {own.nearLimit > 0 ? (
            <Badge variant="warning">{whole(own.nearLimit)}</Badge>
          ) : (
            <span {...stylex.props(styles.figure)}>{whole(own.nearLimit)}</span>
          )}
        </PartRow>
      </PartRows>
    </PagePart>
  );
};

/** Where a connection's sync stands, in words. */
const phaseWords: Record<BrainSyncPhase, string> = {
  listing: "Listing everything",
  relisting: "Daily relist",
  changes: "Following changes",
};

/** Whether a synced connection needs someone: failing, behind, or its relist past its day. */
const needsSomeone = (row: BrainSyncConnection): boolean =>
  row.failing || row.behindSince !== null || row.relistOverdue;

/** Where one synced connection stands: what needs someone in amber, else fine. */
const SyncState = ({ row, now }: { row: BrainSyncConnection; now: number }) => {
  if (!needsSomeone(row)) {
    return <Badge variant="success">Fine</Badge>;
  }
  return (
    <span {...stylex.props(styles.linesEnd)}>
      {row.failing ? <Badge variant="warning">Failing</Badge> : null}
      {row.behindSince === null ? null : (
        <Badge variant="warning">
          {`Behind since ${agoWords(Date.parse(row.behindSince), now)}`}
        </Badge>
      )}
      {row.relistOverdue ? (
        <Badge variant="warning">Relist past its day</Badge>
      ) : null}
    </span>
  );
};

/** Synced connections in a table, each row one sync of one connection. */
const SyncTable = ({
  label,
  rows,
  now,
}: {
  label: string;
  rows: readonly BrainSyncConnection[];
  now: number;
}) => (
  <Table aria-label={label}>
    <TableHeader>
      <TableRow>
        <TableHead>Sync</TableHead>
        <TableHead align="end">Items</TableHead>
        <TableHead align="end">Last synced</TableHead>
        <TableHead>Latest error</TableHead>
        <TableHead align="end">State</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((row) => (
        <TableRow key={`${row.connection} ${row.feed}`}>
          <TableCell wrap>
            <span {...stylex.props(styles.lines)}>
              <span>{`${row.provider} · ${row.feed}`}</span>
              <span {...stylex.props(styles.small)}>
                <span {...stylex.props(styles.mono)}>{row.connection}</span>
                {` · ${phaseWords[row.phase]}`}
              </span>
            </span>
          </TableCell>
          <TableCell align="end">
            <span {...stylex.props(styles.figure)}>{whole(row.items)}</span>
          </TableCell>
          <TableCell align="end">
            {row.syncedAt === null
              ? "Never"
              : agoWords(Date.parse(row.syncedAt), now)}
          </TableCell>
          <TableCell>
            {row.error === null ? (
              <span {...stylex.props(styles.muted)}>None</span>
            ) : (
              <span {...stylex.props(styles.lines)}>
                <span {...stylex.props(styles.mono)}>{row.error.code}</span>
                <span {...stylex.props(styles.small)}>
                  {agoWords(Date.parse(row.error.at), now)}
                </span>
              </span>
            )}
          </TableCell>
          <TableCell align="end">
            <SyncState now={now} row={row} />
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

/**
 * Each connection native sync reads into the Brain, sync by sync: what
 * needs someone (failing, behind, a relist past its day) shown, what is
 * fine folded. Each connection by a hash of its ID alone: never whose it
 * is, its account or anything it holds.
 */
const Synced = ({ report }: { report: BrainReport }) => {
  const now = Date.parse(report.now);
  const description =
    "Each connection synced into the Brain, sync by sync, by a hash of the connection: never whose it is or what it holds.";
  const connections = report.sync?.connections;
  if (connections === undefined) {
    // A core of an older release, on a slower channel, doesn't send them.
    return (
      <PagePart description={description} title="Synced connections">
        <PartRows>
          <PartRow label="Not available yet">
            <span>
              This client’s release doesn’t report its synced connections yet.
            </span>
          </PartRow>
        </PartRows>
      </PagePart>
    );
  }
  if (connections.length === 0) {
    return (
      <PagePart description={description} title="Synced connections">
        <PartRows>
          <PartRow label="Connections">
            <span {...stylex.props(styles.muted)}>None syncs yet</span>
          </PartRow>
        </PartRows>
      </PagePart>
    );
  }
  const attention = connections.filter((row) => needsSomeone(row));
  const fine = connections.filter((row) => !needsSomeone(row));
  return (
    <Collapsible>
      <PagePart
        action={
          fine.length > 0 && attention.length > 0 ? (
            <CollapsibleTrigger asChild>
              <Button size="sm" variant="outline">
                Details
              </Button>
            </CollapsibleTrigger>
          ) : undefined
        }
        description={description}
        title="Synced connections"
      >
        <PartRows>
          <PartRow
            description="Failing, behind (a run of the clock went by without reading it), or its daily relist past its day."
            label="Need someone"
          >
            {attention.length > 0 ? (
              <Badge variant="warning">
                {`${whole(attention.length)} of ${whole(connections.length)}`}
              </Badge>
            ) : (
              <Badge variant="success">None</Badge>
            )}
          </PartRow>
        </PartRows>
        {attention.length > 0 ? (
          <SyncTable
            label="Synced connections that need someone"
            now={now}
            rows={attention}
          />
        ) : (
          <SyncTable label="Synced connections" now={now} rows={fine} />
        )}
        {attention.length > 0 && fine.length > 0 ? (
          <CollapsibleContent asChild>
            <div>
              <SyncTable
                label="Synced connections that are fine"
                now={now}
                rows={fine}
              />
            </div>
          </CollapsibleContent>
        ) : null}
      </PagePart>
    </Collapsible>
  );
};

/** While the section waits for its core, or hasn't asked it (a preload). */
const Reading = () => (
  <EmptyPart>Reading how its Brain is doing from its core…</EmptyPart>
);

/** The Brain at work, or why it isn't shown. */
const Report = ({ acting, read }: { acting: Acting; read: BrainRead }) => {
  // A preload asks nothing: that is no answer yet, not a core that didn't.
  if (read.state === "not_asked") {
    return <Reading />;
  }
  const { report } = read;
  if (report === null) {
    return (
      <EmptyPart>
        The company’s Grasp didn’t answer how its Brain is doing. Open the
        section again to ask once more.
      </EmptyPart>
    );
  }
  return (
    <>
      <Figures report={report} />
      <Parked acting={acting} report={report} />
      <Waiting report={report} />
      <Synced report={report} />
      <Recall report={report} />
      <ModelSpend report={report} />
      <Ledger report={report} />
      <Steps report={report} />
      <OwnStores report={report} />
      <Engine acting={acting} report={report} />
    </>
  );
};

/**
 * The Brain at work, once its core answered: the rest of the page shows
 * meanwhile, never held up by a slow or unreachable core.
 */
export const BrainHealth = ({
  clientId,
  read,
}: {
  clientId: string;
  read: Promise<BrainRead>;
}) => {
  const { busy, said, act } = useBrainAction(clientId);
  return (
    <>
      {said === null ? null : (
        <Alert
          appearance="subtle"
          variant={said.wrong ? "destructive" : "default"}
        >
          <AlertDescription>{said.text}</AlertDescription>
        </Alert>
      )}
      <Await fallback={<Reading />} promise={read}>
        {(answered) => <Report acting={{ busy, act }} read={answered} />}
      </Await>
      <BrainErasureLookupSection clientId={clientId} />
    </>
  );
};
