import type { Gap, Source } from "@grasp-os/shared/brain";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import { Button } from "@grasp-os/ui/components/button";
import {
  AudioWaveformIcon,
  FileIcon,
  SearchIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { media, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  useNavigate,
  useRouteContext,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { formatDay } from "../format.ts";
import { CircleHelpIcon } from "../frame/sidebar-icons.ts";
import { useCoreAction } from "../use-core-action.ts";
import {
  BrainActivityInspector,
  PageBrainActivity,
} from "./brain-activity.tsx";
import type {
  BrainActivityLine,
  BrainActivityPage,
} from "./brain-activity.tsx";
import { useBrainData } from "./brain-data.ts";
import { brainLog } from "./brain-log.ts";
import type { LogEntry, LogKind } from "./brain-log.ts";
import { sourceContents } from "./brain.ts";

// The brain's Activity on the library's page: what changed since the
// person last looked (`brain.changes`), the questions still waiting for an
// answer, then the brain's log this week, last week and before. A line
// opens beside the page: who gave it and when, what the brain kept of it
// and the pages it changed; a question that nobody was asked yet can be
// asked from there, by the company's admins, as core decides.

/** What each kind of line looks like. */
const icons: Record<LogKind, IconData> = {
  interview: AudioWaveformIcon,
  reading: FileIcon,
  scanning: SearchIcon,
  question: CircleHelpIcon,
};

const styles = stylex.create({
  // The brain's own pane that scrolls.
  pane: { flexGrow: 1, minHeight: 0, overflowY: "auto" },
  split: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    alignItems: "start",
    columnGap: space["6"],
    minWidth: 0,
  },
  // On a phone the line in hand takes the page's place; closing it brings the page back.
  pageBeside: { display: { default: "none", [media.lg]: "block" } },
  // Room for the line beside the page only while one is open.
  splitOpen: {
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.lg]: `minmax(0, 1fr) ${size.sidePanelWidth}`,
    },
  },
  inspector: {
    position: { default: "static", [media.lg]: "sticky" },
    insetBlockStart: 0,
    paddingInline: { default: space["4"], [media.lg]: 0 },
    paddingInlineEnd: {
      default: space["4"],
      [media.lg]: space["6"],
    },
  },
});

/** Today, as an ISO date where the reader is. */
const todayHere = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
};

/** Where a line goes when it is opened from beside the page. */
interface Goes {
  to: "note";
  id: string;
}

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
  /** What the line says once opened: worked out only for the line in hand. */
  opened: () => Opened;
}

const listed = (line: BrainActivityLine, opened: () => Opened): Listed => ({
  line,
  opened,
});

export const ActivityPage = () => {
  const { t } = useLingui();
  const { workspace, brain } = useBrainData();
  const { identity } = useRouteContext({ from: "/_shell" });
  const navigate = useNavigate();
  const router = useRouter();
  const { busy, run } = useCoreAction();
  // Why asking failed, beside the question it was about.
  const [failed, setFailed] = useState<{ gap: string; reason: string }>();
  const [open, setOpen] = useState<string>();
  // Where the reader was in the log: on a phone the open line takes the page's place, and closing it comes back here.
  const pane = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const readAt = useRef(0);
  const inspector = useRef<HTMLDivElement>(null);
  // The line in hand takes focus as it opens, so a screen reader is where it opened.
  useEffect(() => {
    if (open !== undefined) {
      inspector.current?.focus({ preventScroll: true });
      // On a phone it stands in the page's place: from its top.
      if (page.current?.checkVisibility() === false) {
        pane.current?.scrollTo({ top: 0 });
      }
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
  // What the brain kept of a source: what was said in it, and for a directory, its teams. The
  // pages it changed: what its note links to, the teams it listed, the pages its statements are on.
  const sourceOpened = (source: Source, icon: IconData): Opened => {
    const kept = workspace.statements.filter(
      (statement) => statement.sourceId === source.id
    );
    const said = new Set(kept.map(({ id }) => id));
    const rows = sourceContents(workspace, source.id)?.rows ?? [];
    return {
      title: source.title,
      icon,
      meta: [
        [source.who, source.how].filter(Boolean).join(" · "),
        formatDay(source.date),
      ].filter((each) => each !== ""),
      kept: [
        ...kept.map(({ text }) => text),
        ...rows.flatMap(({ teamId, people }) => {
          if (people === null) {
            return [];
          }
          const team = notes.get(teamId)?.title ?? teamId;
          return plural(people, {
            one: `${team}: # person`,
            other: `${team}: # people`,
          });
        }),
      ],
      changed: pagesOf(
        [
          ...(notes.get(source.id)?.links ?? []),
          ...rows.map(({ teamId }) => teamId),
          ...brain.notes
            .filter((note) => note.statementIds.some((id) => said.has(id)))
            .map(({ id }) => id),
        ],
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
      icon: CircleHelpIcon,
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
  const waitingListed = workspace.gaps
    .filter((gap) => gap.closedAt === undefined)
    .map((gap) =>
      listed(
        {
          id: `waiting:${gap.id}`,
          icon: CircleHelpIcon,
          name: gap.question,
          detail: gap.owner,
        },
        () => gapOpened(gap)
      )
    );
  const log = brainLog(workspace, brain, todayHere());
  const logListed = (entries: LogEntry[]) =>
    entries.map((entry) =>
      listed(
        {
          id: entry.id,
          icon:
            entry.question !== undefined && gaps.has(entry.question.gap)
              ? CircleHelpIcon
              : icons[entry.kind],
          name: nameOf(entry),
          detail: formatDay(entry.day),
        },
        () => entryOpened(entry)
      )
    );
  const stretches = [
    { id: "this-week", label: t`This week`, listed: logListed(log.thisWeek) },
    { id: "last-week", label: t`Last week`, listed: logListed(log.lastWeek) },
    { id: "earlier", label: t`Earlier`, listed: logListed(log.earlier) },
  ];
  const opened = new Map(
    [...waitingListed, ...stretches.flatMap((stretch) => stretch.listed)].map(
      ({ line, opened: said }) => [line.id, said]
    )
  );

  const inHand = open === undefined ? undefined : opened.get(open)?.();
  const reason =
    failed !== undefined && failed.gap === inHand?.ask?.id
      ? failed.reason
      : undefined;
  const go = (goes: Goes): void => {
    void navigate({ to: "/brain/$noteId", params: { noteId: goes.id } });
  };
  const ask = async (gap: Gap): Promise<void> => {
    setFailed(undefined);
    // Busy until the brain is read again, so the question can't be asked twice.
    await run(
      async (session) => {
        await session.brain.askAboutGap(gap.id);
        await router.invalidate({ sync: true });
      },
      (why) => {
        setFailed({ gap: gap.id, reason: why });
      }
    );
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
            groups={stretches.map(({ id, label, listed: lines }) => ({
              id,
              label,
              lines: lines.map(({ line }) => line),
            }))}
            onOpen={(id) => {
              readAt.current = pane.current?.scrollTop ?? 0;
              setOpen(id);
            }}
            open={open}
            title={t({ message: "Activity", context: "the brain's log" })}
            waiting={waitingListed.map(({ line }) => line)}
            waitingLabel={t`Waiting for an answer`}
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
              error={
                reason === undefined ? undefined : t`Asking failed: ${reason}`
              }
              meta={inHand.meta}
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
            />
          </div>
        )}
      </div>
    </div>
  );
};
