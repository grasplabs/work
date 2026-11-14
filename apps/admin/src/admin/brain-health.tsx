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
 * sizes, recall's counts, and erasures as counts alone. Amber marks what
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
  BrainWithoutMeaningReason,
} from "@grasp-os/shared/brain-report";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Await, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { brainActionFn } from "../clients/brain-functions.ts";
import { thenRefresh } from "../use-action.ts";
import { agoWords } from "./ai-status-words.ts";
import { BrainErasureLookupSection } from "./brain-erasure-lookup.tsx";
import type { BrainRead } from "./brain-loads.ts";
import { Figure } from "./parts.tsx";
import { EmptySection, Section, SectionRow } from "./section.tsx";
import {
  dollars,
  formatList,
  formatMonth,
  formatPercent,
  plural,
  tokens,
  whole,
} from "./words.ts";

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
  embedding: "Putting passages on the queue to embed",
};

const wayWords: Record<BrainSearchWay, string> = {
  words: "Words",
  exact: "Exact parts",
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
    <section
      aria-label="The Brain at work"
      className="overflow-hidden rounded-xl border"
    >
      <div className="bg-border grid grid-cols-2 gap-px lg:grid-cols-4">
        <Figure
          label="Waiting"
          sub={
            waiting === 0
              ? `${whole(queue.running)} running`
              : `${kind}oldest added ${agoWords(oldest, now)}, ${whole(queue.running)} running`
          }
          value={whole(waiting)}
        />
        <Figure
          attention={queue.parkedCount > 0}
          label="Parked"
          sub={
            queue.parkedCount > 0
              ? "Failed too often: requeue below once the cause is fixed"
              : undefined
          }
          value={whole(queue.parkedCount)}
        />
        <Figure
          attention={near}
          label="Store"
          sub={
            near
              ? `Near its limit of ${sizeWords(store.limitBytes)}: writes fail once it is full`
              : `${formatPercent(store.bytes / store.limitBytes)} of ${sizeWords(store.limitBytes)}`
          }
          value={sizeWords(store.bytes)}
        />
        <Figure
          attention={ledger.replay !== "through"}
          label="Erasure ledger"
          sub={
            ledger.replay === "through"
              ? undefined
              : "The Brain answers nothing until it is read through"
          }
          value={replayWords[ledger.replay]}
        />
      </div>
    </section>
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
    <Section title="Queue">
      {pause === null ? null : (
        <SectionRow
          description={`Since ${agoWords(Date.parse(pause.since), now)}: ${pauseWords[pause.reason] ?? pause.reason}. It tries again ${inWords(Date.parse(pause.until), now)}.`}
          label="Waiting for the model"
        >
          <Badge variant="attention">Paused</Badge>
        </SectionRow>
      )}
      {queue.overdue > 0 ? (
        <SectionRow
          description="Their handlers ran past their time and still hold a slot each."
          label="Running past their time"
        >
          <Badge variant="attention">{whole(queue.overdue)}</Badge>
        </SectionRow>
      ) : null}
      {kinds ? (
        <div className="border-t">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead variant="card">Kind</TableHead>
                <TableHead className="text-right" variant="card">
                  Waiting
                </TableHead>
                <TableHead className="text-right" variant="card">
                  Oldest added
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queue.waiting.map(({ kind, count, oldestAddedAt }) => (
                <TableRow key={kind}>
                  <TableCell variant="card">
                    <span className="tabular-nums">{kind}</span>
                  </TableCell>
                  <TableCell className="text-right" variant="card">
                    <span className="tabular-nums">{whole(count)}</span>
                  </TableCell>
                  <TableCell className="text-right" variant="card">
                    {agoWords(Date.parse(oldestAddedAt), now)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </Section>
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
    <Section
      description={`Items that failed too often. Each comes back by itself a day later, up to three times; requeue one to run it now.${shown}`}
      title="Parked"
    >
      <div className="border-t">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead variant="card">Kind</TableHead>
              <TableHead variant="card">Last error</TableHead>
              <TableHead className="text-right" variant="card">
                Attempts
              </TableHead>
              <TableHead className="text-right" variant="card">
                Parked
              </TableHead>
              <TableHead className="text-right" variant="card">
                <span className="sr-only">Requeue</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {parked.map((item) => (
              <TableRow key={item.item}>
                <TableCell variant="card">
                  <span className="tabular-nums">{item.kind}</span>
                </TableCell>
                <TableCell className="whitespace-normal" variant="card">
                  <span className="flex flex-col gap-0.5">
                    <span>{item.message}</span>
                    <span className="text-muted-foreground text-xs">
                      {item.error}
                    </span>
                  </span>
                </TableCell>
                <TableCell className="text-right" variant="card">
                  <span className="tabular-nums">{whole(item.attempts)}</span>
                </TableCell>
                <TableCell className="text-right" variant="card">
                  <span className="flex flex-col items-end gap-0.5">
                    <span>{agoWords(Date.parse(item.parkedAt), now)}</span>
                    {item.final ? (
                      <Badge variant="attention">For good</Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">
                        {`${whole(item.parks)} ${plural(item.parks, "time", "times")}`}
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-right" variant="card">
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
      </div>
    </Section>
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
      <Section
        action={
          <CollapsibleTrigger render={<Button size="sm" variant="outline" />}>
            Details
          </CollapsibleTrigger>
        }
        description="Its word indexes and its embedding, and the rebuild of each."
        title="Engine"
      >
        {/* Kept on the page while folded: found by the page's search. */}
        <CollapsibleContent keepMounted>
          <SectionRow
            description="What recall finds words by. A rebuild rewrites every passage's words from its text, 200 a minute; recall goes on meanwhile."
            label="Word indexes"
          >
            <span className="flex items-center gap-3">
              {rebuilding ? (
                <Badge>Rebuilding</Badge>
              ) : (
                <Badge variant="passed">Current</Badge>
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
          </SectionRow>
          {embedding.model === null ? (
            <SectionRow label="Embedding">
              <span className="text-muted-foreground">
                No embedding model runs yet, so the Brain recalls by words
                alone.
              </span>
            </SectionRow>
          ) : (
            <>
              <SectionRow label="Embedding model">
                <span className="tabular-nums">{embedding.model}</span>
              </SectionRow>
              <SectionRow label="Embedded">
                <span className="tabular-nums">
                  {`${whole(embedding.embedded)} of ${whole(embedding.chunks)} ${plural(embedding.chunks, "passage", "passages")}`}
                </span>
              </SectionRow>
              <SectionRow
                description="Passages the model can't embed: found by words only, until a re-embed."
                label="Passed over"
              >
                <span className="tabular-nums">
                  {whole(embedding.passedOver)}
                </span>
              </SectionRow>
              <SectionRow
                description={
                  embedding.rebuilding && report.queue.parkedCount > 0
                    ? "It waits on what it put on the queue, parked items included: see Parked above. Once the embedders work again, re-embed to put them back now."
                    : "A re-embed puts every passage without its vectors back on the queue, those passed over included."
                }
                label="Embedding's rebuild"
              >
                <span className="flex items-center gap-3">
                  {embedding.rebuilding ? (
                    <Badge>Under way</Badge>
                  ) : (
                    <Badge variant="passed">Done</Badge>
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
              </SectionRow>
            </>
          )}
        </CollapsibleContent>
      </Section>
    </Collapsible>
  );
};

/** How recall did by each way, and how often it went without meaning. */
const Recall = ({ report }: { report: BrainReport }) => {
  const { recall } = report;
  return (
    <Section
      description={`Since the store last started, ${agoWords(Date.parse(recall.since), Date.parse(report.now))}. A recall searches by each way the question has something for.`}
      title="Recall"
    >
      <div className="border-t">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead variant="card">Way</TableHead>
              <TableHead className="text-right" variant="card">
                Recalls
              </TableHead>
              <TableHead className="text-right" variant="card">
                Failed
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {brainSearchWays.map((way) => {
              const counts = recall.ways[way];
              return (
                <TableRow key={way}>
                  <TableCell variant="card">{wayWords[way]}</TableCell>
                  <TableCell className="text-right" variant="card">
                    <span className="tabular-nums">
                      {whole(counts.recalls)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right" variant="card">
                    {counts.failed > 0 ? (
                      <Badge variant="attention">{whole(counts.failed)}</Badge>
                    ) : (
                      <span className="tabular-nums">0</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <SectionRow
        description="Recalls by words and exact parts alone, as the embedding model gave no vector for the question in time or none the Brain could use. Without a model, none is counted."
        label="Without meaning"
      >
        <span className="tabular-nums">
          {formatList(
            brainWithoutMeaningReasons.map(
              (reason) =>
                `${whole(recall.withoutMeaning[reason])} ${withoutMeaningWords[reason]}`
            )
          )}
        </span>
      </SectionRow>
    </Section>
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
      <Section title="Model spend">
        <SectionRow label="Not available yet">
          <span>This client’s release doesn’t report model spend yet.</span>
        </SectionRow>
      </Section>
    );
  }
  const month = formatMonth(spend.month);
  return (
    <Section
      description={`${month}, as the model gateway recorded each answered call, at the providers’ list prices: on the client’s own keys, their provider’s invoice is the bill.`}
      title="Model spend"
    >
      {spend.purposes.length === 0 ? (
        <SectionRow label={`No model calls in ${month}`}>
          <span className="tabular-nums">{dollars(0)}</span>
        </SectionRow>
      ) : (
        <div className="border-t">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead variant="card">Purpose</TableHead>
                <TableHead className="text-right" variant="card">
                  Calls
                </TableHead>
                <TableHead className="text-right" variant="card">
                  Tokens in
                </TableHead>
                <TableHead className="text-right" variant="card">
                  Tokens out
                </TableHead>
                <TableHead className="text-right" variant="card">
                  Cost
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {spend.purposes.map((used) => (
                <TableRow key={used.purpose}>
                  <TableCell variant="card">
                    <code>{used.purpose}</code>
                  </TableCell>
                  <TableCell className="text-right" variant="card">
                    <span className="tabular-nums">{whole(used.calls)}</span>
                  </TableCell>
                  <TableCell className="text-right" variant="card">
                    <span className="tabular-nums">
                      {tokens(used.inputTokens)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right" variant="card">
                    <span className="tabular-nums">
                      {tokens(used.outputTokens)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right" variant="card">
                    <span className="tabular-nums">{dollars(used.cost)}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Section>
  );
};

/**
 * The erasure ledger in one line, its counters under it: by kind, by
 * reason, and not yet written. Open by itself while an entry is still
 * to write.
 */
const Ledger = ({ report }: { report: BrainReport }) => {
  const { ledger } = report;
  const unwritten = ledger.source.unwritten + ledger.person.unwritten;
  return (
    <Collapsible defaultOpen={unwritten > 0}>
      <Section
        action={
          <CollapsibleTrigger render={<Button size="sm" variant="outline" />}>
            Details
          </CollapsibleTrigger>
        }
        description="Every erasure, counted: never which, or when."
        title="Erasures"
      >
        <SectionRow
          description="Erased sources and people, whole, with their ledger entry written."
          label="In the ledger"
        >
          <span className="flex items-center gap-3">
            {unwritten > 0 ? (
              <Badge variant="attention">
                {`${whole(unwritten)} not yet written`}
              </Badge>
            ) : null}
            <span className="tabular-nums">
              {`${whole(ledger.source.written)} ${plural(ledger.source.written, "source", "sources")}, ${whole(ledger.person.written)} ${plural(ledger.person.written, "person", "people")}`}
            </span>
          </span>
        </SectionRow>
        <CollapsibleContent keepMounted>
          <SectionRow
            description="Erased and hidden, their ledger entry still to write: each tick tries again."
            label="Not yet written"
          >
            <span className="tabular-nums">{whole(unwritten)}</span>
          </SectionRow>
          <SectionRow
            description="Hidden already; the tick deletes what they held a batch at a time."
            label="Still being deleted"
          >
            <span className="tabular-nums">{whole(ledger.erasing)}</span>
          </SectionRow>
          <SectionRow
            description="Sources with versions kept but none current, so nobody can read them: what a replay can leave."
            label="Sources without a current version"
          >
            <span className="tabular-nums">
              {whole(ledger.sourcesWithoutCurrent)}
            </span>
          </SectionRow>
          <SectionRow label="By reason">
            <span className="tabular-nums">
              {formatList(
                reasonOrder.map(
                  (reason) =>
                    `${whole(ledger.byReason[reason])} ${reasonWords[reason]}`
                )
              )}
            </span>
          </SectionRow>
        </CollapsibleContent>
      </Section>
    </Collapsible>
  );
};

/** The tick's own steps that failed since the store started, or one line when none did. */
const Steps = ({ report }: { report: BrainReport }) => {
  const now = Date.parse(report.now);
  const failing = brainSteps.flatMap((step) => {
    const failed = report.stepsFailed[step];
    return failed === null ? [] : [{ step, failed }];
  });
  return (
    <Section
      description={
        failing.length > 0
          ? "A failure shows until a later tick gets through."
          : undefined
      }
      title="Upkeep"
    >
      {failing.length === 0 ? (
        <SectionRow label="Every step of its upkeep got through">
          <Badge variant="passed">Fine</Badge>
        </SectionRow>
      ) : (
        failing.map(({ step, failed }) => (
          <SectionRow key={step} label={stepWords[step]}>
            <Badge variant="attention">
              {`${failed.reason === "timed_out" ? "Timed out" : "Failed"} ${agoWords(Date.parse(failed.at), now)}`}
            </Badge>
          </SectionRow>
        ))
      )}
    </Section>
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
      <Section description={description} title="People's own stores">
        <SectionRow label="Not available yet">
          <span>
            This client’s release doesn’t report people’s own stores yet.
          </span>
        </SectionRow>
      </Section>
    );
  }
  const people = `${whole(own.stores)} ${plural(own.stores, "person", "people")}`;
  return (
    <Section description={description} title="People's own stores">
      <SectionRow
        description="Stores holding anything, as their own upkeep last found them."
        label="Stores"
      >
        <span className="tabular-nums">{people}</span>
      </SectionRow>
      <SectionRow
        description={
          own.oldestWaitingAt === null
            ? undefined
            : `Oldest added ${agoWords(Date.parse(own.oldestWaitingAt), now)}.`
        }
        label="Waiting"
      >
        <span className="tabular-nums">{whole(own.waiting)}</span>
      </SectionRow>
      <SectionRow
        description="Failed too often in someone's store; they come back by themselves unless parked for good."
        label="Parked"
      >
        {own.parked > 0 ? (
          <Badge variant="attention">{whole(own.parked)}</Badge>
        ) : (
          <span className="tabular-nums">{whole(own.parked)}</span>
        )}
      </SectionRow>
      <SectionRow
        description="Stores whose last upkeep failed a step, waits for the model, or hasn't read its erasure ledger through."
        label="Failing"
      >
        {own.failing > 0 ? (
          <Badge variant="attention">{whole(own.failing)}</Badge>
        ) : (
          <Badge variant="passed">None</Badge>
        )}
      </SectionRow>
      <SectionRow
        description="Stores whose passages aren't all embedded by the current model yet."
        label="Embedding not done"
      >
        <span className="tabular-nums">{whole(own.notRebuilt)}</span>
      </SectionRow>
      <SectionRow
        description="Stores near what one store holds: writes fail once one is full."
        label="Near the limit"
      >
        {own.nearLimit > 0 ? (
          <Badge variant="attention">{whole(own.nearLimit)}</Badge>
        ) : (
          <span className="tabular-nums">{whole(own.nearLimit)}</span>
        )}
      </SectionRow>
    </Section>
  );
};

/** While the section waits for its core, or hasn't asked it (a preload). */
const Reading = () => (
  <EmptySection>Reading how its Brain is doing from its core…</EmptySection>
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
      <EmptySection>
        The company’s Grasp didn’t answer how its Brain is doing. Open the
        section again to ask once more.
      </EmptySection>
    );
  }
  return (
    <>
      <Figures report={report} />
      <Parked acting={acting} report={report} />
      <Waiting report={report} />
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
        <p
          className={
            said.wrong
              ? "text-destructive text-sm"
              : "text-muted-foreground text-sm"
          }
          role={said.wrong ? "alert" : "status"}
        >
          {said.text}
        </p>
      )}
      <Await fallback={<Reading />} promise={read}>
        {(answered) => <Report acting={{ busy, act }} read={answered} />}
      </Await>
      <BrainErasureLookupSection clientId={clientId} />
    </>
  );
};
