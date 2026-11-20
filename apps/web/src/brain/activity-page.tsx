import type {
  BrainChange,
  BrainChangePage,
  Gap,
  Source,
} from "@grasp-os/shared/brain";
import { failureText } from "@grasp-os/shared/errors";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  useNavigate,
  useRouteContext,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { formatDateTime, formatDay } from "../format.ts";
import {
  BrainActivityInspector,
  PageBrainActivity,
} from "../grasp/blocks/page-brain-activity/page-brain-activity.tsx";
import type {
  BrainActivityLine,
  BrainActivityPage,
} from "../grasp/blocks/page-brain-activity/page-brain-activity.tsx";
import { Button } from "../grasp/button/index.ts";
import {
  File,
  Inbox,
  Listening,
  Question,
  Search,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { useBrainData } from "./brain-data.ts";
import { brainLog } from "./brain-log.ts";
import type { LogEntry, LogKind } from "./brain-log.ts";
import { keepLooked, lastLooked } from "./last-looked.ts";

// The brain's Activity on the library's page: what changed since the
// person last looked (`brain.changes`), the questions still waiting for an
// answer, then the brain's log this week, last week and before. A line
// opens beside the page: who gave it and when, what the brain kept of it
// and the pages it changed; a question that nobody was asked yet can be
// asked from there, by the company's admins, as core decides.

/** What each kind of line looks like. */
const icons: Record<LogKind, IconData> = {
  interview: Listening,
  reading: File,
  scanning: Search,
  question: Question,
};

const styles = stylex.create({
  // The brain's own pane that scrolls.
  pane: { flexGrow: 1, minHeight: 0, overflowY: "auto" },
  split: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    alignItems: "start",
    columnGap: grasp.space6,
    minWidth: 0,
  },
  // On a phone the line in hand takes the page's place; closing it brings the page back.
  pageBeside: { display: { default: "none", [media.fromSidebar]: "block" } },
  // Room for the line beside the page only while one is open.
  splitOpen: {
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.fromSidebar]: `minmax(0, 1fr) ${grasp.inspectorWidth}`,
    },
  },
  inspector: {
    position: { default: "static", [media.fromSidebar]: "sticky" },
    insetBlockStart: 0,
    paddingBlock: grasp.space8,
    paddingInline: { default: grasp.space4, [media.fromSidebar]: 0 },
    paddingInlineEnd: {
      default: grasp.space4,
      [media.fromSidebar]: grasp.space6,
    },
  },
});

/** What changed since the last look, or why it couldn't be read. */
type Fresh =
  | { state: "loading" }
  | { state: "failed"; reason: string }
  | { state: "ready"; since: string; changes: BrainChange[]; more: boolean };

/** How many of the changes since the last look the page lists: the newest, so the log stays in view. */
const freshShown = 10;

/**
 * The newest changes after `since`. Outside the component, as the React
 * Compiler can't compile `try`/`catch` around a value it returns.
 */
const readChanges = async (
  core: Pick<CoreConnection, "withSession">,
  since: string
): Promise<{ page: BrainChangePage } | { reason: string }> => {
  try {
    const page = await core.withSession(
      async (session) =>
        await session.brain.changes({ since, limit: freshShown })
    );
    return { page };
  } catch (error) {
    return { reason: failureText(error) };
  }
};

/** Today, as an ISO date where the reader is. */
const todayHere = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
};

/** Where a line goes when it is opened from beside the page. */
type Goes =
  | { to: "note"; id: string }
  | { to: "document"; collection: string; doc: string };

/** One line as it opens beside the page. */
interface Opened {
  title: string;
  icon: IconData;
  meta: string[];
  kept: string[];
  changed: BrainActivityPage[];
  goes?: Goes;
  /** A question nobody was asked yet. */
  ask?: Gap;
}

/** A line of the page, and what it opens beside it. */
interface Listed {
  line: BrainActivityLine;
  opened: Opened;
}

const listed = (
  id: string,
  opened: Opened,
  detail: string,
  name = opened.title
): Listed => ({ line: { id, icon: opened.icon, name, detail }, opened });

/** What changed since the last look, read as the page opens; the look then counts as seen. */
const useFresh = (): Fresh => {
  const core = useCore();
  const { identity } = useRouteContext({ from: "/_shell" });
  const [fresh, setFresh] = useState<Fresh>({ state: "loading" });
  useEffect(() => {
    let left = false;
    const asked = new Date();
    const since = lastLooked(identity.userId, asked);
    const load = async (): Promise<void> => {
      const answer = await readChanges(core, since);
      if (left) {
        return;
      }
      if ("reason" in answer) {
        setFresh({ state: "failed", reason: answer.reason });
        return;
      }
      setFresh({
        state: "ready",
        since,
        changes: answer.page.changes,
        more: answer.page.next !== null,
      });
      keepLooked(identity.userId, asked);
    };
    void load();
    return () => {
      left = true;
    };
  }, [core, identity.userId]);
  return fresh;
};

export const ActivityPage = () => {
  const { t } = useLingui();
  const { workspace, brain } = useBrainData();
  const { identity } = useRouteContext({ from: "/_shell" });
  const navigate = useNavigate();
  const router = useRouter();
  const { busy, run } = useCoreAction();
  // Why asking failed, beside the question it was about.
  const [failed, setFailed] = useState<{ gap: string; reason: string }>();
  const fresh = useFresh();
  const [open, setOpen] = useState<string>();
  // Where the reader was in the log: on a phone the open line takes the page's place, and closing it comes back here.
  const pane = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const readAt = useRef(0);
  const inspector = useRef<HTMLDivElement>(null);
  // The line in hand takes focus as it opens, so a screen reader is where it opened.
  useEffect(() => {
    if (open !== undefined) {
      inspector.current?.focus();
    }
  }, [open]);

  const notes = new Map(brain.notes.map((note) => [note.id, note]));
  const sources = new Map(
    workspace.sources.map((source) => [source.id, source])
  );
  const pagesOf = (ids: Iterable<string>, but?: string): BrainActivityPage[] =>
    [...new Set(ids)].flatMap((id) => {
      const note = notes.get(id);
      return note === undefined || id === but
        ? []
        : [{ id: note.id, name: note.title }];
    });
  // A source: who gave it and when, what the brain kept of it, the pages its statements are on.
  const sourceOpened = (source: Source, icon: IconData): Opened => {
    const kept = workspace.statements.filter(
      (statement) => statement.sourceId === source.id
    );
    const said = new Set(kept.map(({ id }) => id));
    return {
      title: source.title,
      icon,
      meta: [
        [source.who, source.how].filter(Boolean).join(" · "),
        formatDay(source.date),
      ].filter((each) => each !== ""),
      kept: kept.map(({ text }) => text),
      changed: pagesOf(
        brain.notes
          .filter((note) => note.statementIds.some((id) => said.has(id)))
          .map(({ id }) => id),
        source.id
      ),
      ...(notes.has(source.id) ? { goes: { to: "note", id: source.id } } : {}),
    };
  };
  // A question: where it was noticed, who it waits on or who answered, and what it is about.
  const gapOpened = (gap: Gap): Opened => {
    const source = sources.get(gap.sourceId)?.title;
    const { owner } = gap;
    const { answer } = gap;
    let state = t`Waits on the ${owner}, nobody asked yet`;
    if (answer !== undefined) {
      state = t`${owner}: “${answer}”`;
    } else if (gap.closedAt !== undefined) {
      state = t`Closed without an answer`;
    } else if (gap.askedAt !== undefined) {
      const day = formatDay(gap.askedAt);
      state = t`Sent to the ${owner} on ${day}`;
    }
    return {
      title: gap.question,
      icon: Question,
      meta: [...(source === undefined ? [] : [t`Noticed in ${source}`]), state],
      kept: [],
      changed: pagesOf(gap.about),
      ...(notes.has(gap.id) ? { goes: { to: "note", id: gap.id } } : {}),
      ...(gap.askedAt === undefined && gap.closedAt === undefined
        ? { ask: gap }
        : {}),
    };
  };
  const gaps = new Map(workspace.gaps.map((gap) => [gap.id, gap]));
  const nameOf = (entry: LogEntry): string => {
    const { title } = entry;
    if (entry.interviews) {
      const { count, week } = entry.interviews;
      return plural(count, {
        one: `# interview in week ${week}`,
        other: `# interviews in week ${week}`,
      });
    }
    if (entry.question?.step === "answered") {
      return t`Answered: ${title}`;
    }
    if (entry.question?.step === "asked") {
      return t`Asked: ${title}`;
    }
    return title;
  };
  const entryOpened = (entry: LogEntry): Opened => {
    const gap =
      entry.question === undefined ? undefined : gaps.get(entry.question.gap);
    if (gap !== undefined) {
      return gapOpened(gap);
    }
    const source = sources.get(entry.id);
    if (source !== undefined) {
      return sourceOpened(source, icons[entry.kind]);
    }
    // A week's interviews: how many, never who talked.
    return {
      title: nameOf(entry),
      icon: icons[entry.kind],
      meta: [t`What was said is on the work it was about`],
      kept: [],
      changed: [],
      ...(entry.opens === undefined
        ? {}
        : { goes: { to: "note", id: entry.opens } }),
    };
  };
  const changeOpened = (change: BrainChange): Opened => {
    const at = formatDateTime(change.at);
    if (change.kind === "source") {
      const source = sources.get(change.source.id);
      return source === undefined
        ? {
            title: change.source.title,
            icon: Inbox,
            meta: [t`Came in ${at}`],
            kept: [],
            changed: [],
            ...(notes.has(change.source.id)
              ? { goes: { to: "note", id: change.source.id } }
              : {}),
          }
        : sourceOpened(source, Inbox);
    }
    const { document } = change;
    return {
      title: document.title,
      icon: File,
      meta: [change.change === "added" ? t`Added ${at}` : t`Changed ${at}`],
      kept: [],
      changed: [],
      goes: {
        to: "document",
        collection: document.collectionId,
        doc: document.id,
      },
    };
  };

  const freshListed =
    fresh.state === "ready"
      ? fresh.changes.map((change) =>
          listed(
            change.kind === "source"
              ? `fresh:source:${change.source.id}`
              : `fresh:document:${change.document.id}`,
            changeOpened(change),
            formatDateTime(change.at)
          )
        )
      : [];
  const waitingListed = workspace.gaps
    .filter((gap) => gap.closedAt === undefined)
    .map((gap) => listed(`waiting:${gap.id}`, gapOpened(gap), gap.owner));
  const log = brainLog(workspace, brain, todayHere());
  const logListed = (entries: LogEntry[]) =>
    entries.map((entry) =>
      listed(entry.id, entryOpened(entry), formatDay(entry.day), nameOf(entry))
    );
  const stretches = [
    { id: "this-week", label: t`This week`, listed: logListed(log.thisWeek) },
    { id: "last-week", label: t`Last week`, listed: logListed(log.lastWeek) },
    { id: "earlier", label: t`Earlier`, listed: logListed(log.earlier) },
  ];
  const opened = new Map(
    [
      ...freshListed,
      ...waitingListed,
      ...stretches.flatMap((stretch) => stretch.listed),
    ].map(({ line, opened: said }) => [line.id, said])
  );

  let description: string | undefined;
  if (fresh.state === "failed") {
    const { reason } = fresh;
    description = t`What changed since you last looked couldn't be read: ${reason}`;
  } else if (fresh.state === "ready") {
    const when = formatDateTime(fresh.since);
    const shown = fresh.changes.length;
    description = t`What came in since ${when}.`;
    if (shown === 0) {
      description = t`Nothing has changed since ${when}.`;
    } else if (fresh.more) {
      description = plural(shown, {
        one: `What came in since ${when}: the newest change is shown.`,
        other: `What came in since ${when}: the newest # changes are shown.`,
      });
    }
  }

  const inHand = open === undefined ? undefined : opened.get(open);
  const go = (goes: Goes): void => {
    if (goes.to === "note") {
      void navigate({ to: "/brain/$noteId", params: { noteId: goes.id } });
      return;
    }
    void navigate({
      to: "/knowledge/$collection",
      params: { collection: goes.collection },
      search: { doc: goes.doc },
    });
  };
  const ask = async (gap: Gap): Promise<void> => {
    setFailed(undefined);
    // Busy until the brain is read again, so the question can't be asked twice.
    await run(
      async (session) => {
        await session.brain.askAboutGap(gap.id);
        await router.invalidate();
      },
      (reason) => {
        setFailed({ gap: gap.id, reason });
      }
    );
  };
  const words = {
    title: t({ message: "Activity", context: "the brain's log" }),
    fresh: t`Since you last looked`,
    waiting: t`Waiting for an answer`,
    kept: t`What the brain kept`,
    changed: t`Pages it changed`,
  };
  return (
    <div ref={pane} {...stylex.props(styles.pane)}>
      <div
        {...stylex.props(
          styles.split,
          inHand !== undefined && styles.splitOpen
        )}
      >
        <div
          ref={page}
          {...stylex.props(inHand !== undefined && styles.pageBeside)}
        >
          <PageBrainActivity
            description={description}
            fresh={freshListed.map(({ line }) => line)}
            groups={stretches.map(({ id, label, listed: lines }) => ({
              id,
              label,
              lines: lines.map(({ line }) => line),
            }))}
            onOpen={(id) => {
              readAt.current = pane.current?.scrollTop ?? 0;
              setOpen(id);
            }}
            waiting={waitingListed.map(({ line }) => line)}
            words={words}
          />
        </div>
        {inHand === undefined ? null : (
          <div
            ref={inspector}
            tabIndex={-1}
            {...stylex.props(styles.inspector)}
          >
            <BrainActivityInspector
              actions={
                <>
                  {inHand.ask !== undefined && isMemberAdmin(identity) ? (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        if (inHand.ask !== undefined) {
                          void ask(inHand.ask);
                        }
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      {t({
                        message: "Ask",
                        context: "a question of the brain",
                      })}
                    </Button>
                  ) : null}
                  {inHand.goes === undefined ? null : (
                    <Button
                      onClick={() => {
                        if (inHand.goes !== undefined) {
                          go(inHand.goes);
                        }
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      {t`Open`}
                    </Button>
                  )}
                </>
              }
              changed={inHand.changed}
              icon={inHand.icon}
              kept={inHand.kept}
              meta={
                failed !== undefined && failed.gap === inHand.ask?.id
                  ? [...inHand.meta, failed.reason]
                  : inHand.meta
              }
              onClose={() => {
                // Only a phone hid the log; beside it, the reader may have scrolled on.
                const hidden = page.current?.checkVisibility() === false;
                setOpen(undefined);
                setFailed(undefined);
                if (hidden) {
                  requestAnimationFrame(() => {
                    pane.current?.scrollTo({ top: readAt.current });
                  });
                }
              }}
              onOpenPage={(id) => {
                go({ to: "note", id });
              }}
              title={inHand.title}
              words={words}
            />
          </div>
        )}
      </div>
    </div>
  );
};
