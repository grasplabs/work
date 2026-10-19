import type {
  Source,
  Statement,
  StatementKind,
  Transcript,
} from "@grasp-os/shared/brain";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  HighlighterIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { tintClass } from "./brain-colors.ts";
import { statementKindLabel } from "./brain.ts";
import { KindLabel, kindIcon } from "./statement-kind.tsx";
import { hoverDelay, ToolbarLabel } from "./toolbar.tsx";
import {
  chapterOfTurns,
  highlightsOf,
  isGrasp,
  placeLabel,
  searchHits,
  turnParts,
  voices,
} from "./transcript.ts";
import type { Highlight } from "./transcript.ts";

// A source's own words, as the prototype shows them
// (`components/brain-transcript.tsx`): a conversation turn by turn, a
// document as a page, and beside them their topics and statements.

/** A source that has its conversation word for word. */
export type TranscribedSource = Source & { transcript: Transcript };

/** Where a chapter's heading sits, so the topics beside the transcript can scroll to it. */
const chapterAnchor = (sourceId: string, chapter: number): string =>
  `${sourceId}-topic-${chapter}`;

/**
 * The soft fills behind the people in a conversation, in the order they first speak. They borrow
 * the graph's hues, but not the statements' pink, which marks what was tagged in the text.
 */
const voiceTints = [
  "bg-graph-teams/20",
  "bg-graph-tools/20",
  "bg-graph-vision/25",
  "bg-graph-candidates/20",
  "bg-graph-gaps/20",
];

/** The order kinds are listed in, the ones that hurt first. */
const kindOrder: StatementKind[] = [
  "blocker",
  "timeSink",
  "handover",
  "tool",
  "rule",
  "wish",
  "goal",
];

/** How a run of a turn looks where the search found it: the hit being stepped to stands out. */
const hitMark = (hit: number | undefined, current: number): string => {
  if (hit === undefined) {
    return "";
  }
  return hit === current
    ? "bg-graph-vision/40 ring-graph-vision rounded-sm ring-1"
    : "bg-graph-vision/25 rounded-sm";
};

/** A turn's words: highlights in the statements' colour with their kind in front, search hits marked. */
const TurnText = ({
  text,
  highlights,
  hits,
  length,
  current,
}: {
  text: string;
  highlights: Highlight[];
  hits: { start: number; index: number }[];
  length: number;
  current: number;
}) => {
  const parts = turnParts(text, highlights, hits, length);
  return (
    <>
      {parts.map((part, index) => {
        const opens =
          part.statement !== undefined &&
          parts[index - 1]?.statement !== part.statement;
        const hitClass = hitMark(part.hit, current);
        const body = (
          <span className={hitClass} data-hit={part.hit}>
            {part.text}
          </span>
        );
        if (!part.statement) {
          return <span key={index}>{body}</span>;
        }
        return (
          <span
            className={`scroll-mt-24 box-decoration-clone py-0.5 ${tintClass("statement")} ${opens ? "rounded-l-sm pl-1" : ""} ${parts[index + 1]?.statement === part.statement ? "" : "rounded-r-sm pr-1"}`}
            data-statement={opens ? part.statement.id : undefined}
            key={index}
          >
            {opens ? (
              <span className="mr-1.5 inline-flex items-center gap-1 align-middle text-xs font-medium">
                <KindLabel kind={part.statement.kind} />
              </span>
            ) : null}
            {body}
          </span>
        );
      })}
    </>
  );
};

/** The transcript's filter, as in the Landscape toolbar: a hover menu with the kinds said, and a switch to show only highlighted turns. */
const TranscriptFilter = ({
  highlights,
  kinds,
  onKindsChange,
  onlyHighlights,
  onOnlyHighlightsChange,
}: {
  highlights: Highlight[];
  kinds: StatementKind[];
  onKindsChange: (kinds: StatementKind[]) => void;
  onlyHighlights: boolean;
  onOnlyHighlightsChange: (only: boolean) => void;
}) => {
  const { i18n } = useLingui();
  const [open, setOpen] = useState(false);
  const said = kindOrder.filter((kind) =>
    highlights.some((highlight) => highlight.statement.kind === kind)
  );
  const active = kinds.length + (onlyHighlights ? 1 : 0);
  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger
        closeDelay={hoverDelay.close}
        delay={hoverDelay.open}
        openOnHover
        render={<Button size="sm" variant="outline" />}
      >
        <SlidersHorizontalIcon data-icon="inline-start" />
        <ToolbarLabel>
          <Trans context="open the filters">Filter</Trans>
        </ToolbarLabel>
        {active > 0 ? <Badge variant="secondary">{active}</Badge> : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <Trans>Kind of statement</Trans>
          </DropdownMenuLabel>
          {said.map((kind) => {
            const Icon = kindIcon[kind];
            return (
              <DropdownMenuCheckboxItem
                checked={kinds.includes(kind)}
                closeOnClick={false}
                key={kind}
                onCheckedChange={(checked) => {
                  onKindsChange(
                    checked
                      ? [...kinds, kind]
                      : kinds.filter((each) => each !== kind)
                  );
                }}
              >
                <Icon />
                <span className="flex-1">
                  {i18n._(statementKindLabel[kind])}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {
                    highlights.filter(
                      (highlight) => highlight.statement.kind === kind
                    ).length
                  }
                </span>
              </DropdownMenuCheckboxItem>
            );
          })}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuCheckboxItem
            checked={onlyHighlights}
            closeOnClick={false}
            onCheckedChange={onOnlyHighlightsChange}
          >
            <HighlighterIcon />
            <Trans>Only highlighted turns</Trans>
          </DropdownMenuCheckboxItem>
        </DropdownMenuGroup>
        {active > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={() => {
                  onKindsChange([]);
                  onOnlyHighlightsChange(false);
                }}
              >
                <XIcon />
                <Trans>Clear filters</Trans>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** The search and filter: where they were given, once that row is there; above the transcript without one. */
const placed = (
  tools: ReactNode,
  toolbarIn: HTMLElement | null | undefined
): ReactNode => {
  if (toolbarIn === undefined) {
    return tools;
  }
  return toolbarIn ? createPortal(tools, toolbarIn) : null;
};

/** How a turn sits in the transcript: the one a link opened, one by who spoke just before, or a turn of its own. */
const turnClass = (isActive: boolean, continues: boolean): string => {
  if (isActive) {
    return "bg-background ring-foreground grid grid-cols-[3rem_9rem_1fr] gap-x-4 rounded-lg px-3 py-2.5 text-sm leading-6 ring-2";
  }
  return continues
    ? "grid grid-cols-[3rem_9rem_1fr] gap-x-4 rounded-lg px-3 pt-0.5 pb-1 text-sm leading-6"
    : "grid grid-cols-[3rem_9rem_1fr] gap-x-4 rounded-lg px-3 pt-2.5 pb-1 text-sm leading-6";
};

/**
 * A conversation word for word, by topic, with its statements highlighted where they were said. A
 * search finds words in it and steps through them; a filter, as in the Landscape toolbar, narrows
 * it to kinds of statement or to the highlighted turns only. The statement in the address is the
 * one a link opened: its turn is marked and scrolled into view.
 */
export const TranscriptView = ({
  source,
  statements,
  activeId,
  toolbarIn,
}: {
  source: TranscribedSource;
  statements: Statement[];
  activeId?: string | undefined;
  /**
   * Where the search and filter go when the page has a row for them, such as beside its tabs. Null
   * while that row is not there yet; left out, they sit above the transcript.
   */
  toolbarIn?: HTMLElement | null;
}) => {
  const { t } = useLingui();
  const { turns, chapters } = source.transcript;
  const label = (at: string): string => placeLabel(source.transcript, at);
  // Documents are read as a page (DocumentView), so this is always a conversation.
  const search = t`Search the transcript`;
  const highlights = highlightsOf(source, statements);
  const chapterOf = chapterOfTurns(source.transcript);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const [kinds, setKinds] = useState<StatementKind[]>([]);
  const [onlyHighlights, setOnlyHighlights] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const shownHighlights =
    kinds.length === 0
      ? highlights
      : highlights.filter((highlight) =>
          kinds.includes(highlight.statement.kind)
        );
  const hits = searchHits(turns, query);
  const hit = hits.length === 0 ? 0 : Math.min(current, hits.length - 1);
  const needleLength = query.trim().length;
  const active = highlights.find(
    (highlight) => highlight.statement.id === activeId
  );
  const filtering = kinds.length > 0 || onlyHighlights;
  const visible = (index: number): boolean =>
    !onlyHighlights ||
    shownHighlights.some((highlight) => highlight.turn === index);
  // Each person keeps one colour behind their name, so who said what reads at a glance; Grasp stays grey.
  const people = voices(turns);
  const voiceTint = (speaker: string): string =>
    isGrasp(speaker)
      ? "bg-muted text-muted-foreground"
      : (voiceTints[people.indexOf(speaker) % voiceTints.length] ?? "");
  // Who spoke in the shown turn before each one. Someone who says several things in a row is named once.
  const speakerBefore: (string | undefined)[] = [];
  for (const [index] of turns.entries()) {
    const shownBefore = index > 0 && visible(index - 1);
    speakerBefore.push(
      shownBefore ? turns[index - 1]?.speaker : speakerBefore[index - 1]
    );
  }

  // Bring the statement a link opened into view, and later the search hit being stepped to.
  useEffect(() => {
    if (activeId === undefined) {
      return;
    }
    box.current
      ?.querySelector(`[data-statement="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [activeId]);
  useEffect(() => {
    if (needleLength < 2) {
      return;
    }
    box.current
      ?.querySelector(`[data-hit="${hit}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [hit, needleLength]);

  // Which search hit is shown, counted from one, of how many.
  const match = hit + 1;
  const matches = hits.length;

  const step = (by: number): void => {
    if (hits.length > 0) {
      setCurrent((hit + by + hits.length) % hits.length);
    }
  };

  // Search and filter: above the transcript, or in the row the page made for them.
  const tools = (
    <div className="flex flex-wrap items-center gap-2">
      <InputGroup className="h-8 w-56">
        <InputGroupInput
          aria-label={search}
          onChange={(event) => {
            setQuery(event.target.value);
            setCurrent(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              step(event.shiftKey ? -1 : 1);
            }
          }}
          placeholder={search}
          type="search"
          value={query}
        />
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
      </InputGroup>
      {needleLength >= 2 ? (
        <span
          aria-live="polite"
          className="text-muted-foreground flex items-center gap-1 tabular-nums"
        >
          {hits.length === 0 ? (
            <Trans>No matches</Trans>
          ) : (
            <Trans>
              {match} of {matches}
            </Trans>
          )}
          <Button
            aria-label={t`Previous match`}
            onClick={() => {
              step(-1);
            }}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronUpIcon />
          </Button>
          <Button
            aria-label={t`Next match`}
            onClick={() => {
              step(1);
            }}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronDownIcon />
          </Button>
        </span>
      ) : null}
      <div className="ml-auto">
        {/* One button, so no toolbar frame: on its own it stands as tall as the search beside it. */}
        <TranscriptFilter
          highlights={highlights}
          kinds={kinds}
          onKindsChange={setKinds}
          onlyHighlights={onlyHighlights}
          onOnlyHighlightsChange={setOnlyHighlights}
        />
      </div>
    </div>
  );

  return (
    <section className="flex flex-col gap-3">
      {placed(tools, toolbarIn)}

      <div className="flex flex-col" ref={box}>
        {turns.map((turn, index) => {
          if (!visible(index)) {
            return null;
          }
          const chapterIndex = chapterOf[index] ?? 0;
          const opensChapter =
            index === 0 || chapterIndex !== chapterOf[index - 1];
          const chapter = chapters[chapterIndex];
          const next = chapters[chapterIndex + 1];
          const own = shownHighlights.filter(
            (highlight) => highlight.turn === index
          );
          const turnHits = hits.flatMap((each, at) =>
            each.turn === index ? [{ start: each.start, index: at }] : []
          );
          const isActive = active?.turn === index;
          const continues =
            !opensChapter && speakerBefore[index] === turn.speaker;
          return (
            <div className="flex flex-col" key={`${turn.at}-${index}`}>
              {opensChapter && chapter ? (
                <div
                  className="text-muted-foreground flex scroll-mt-4 items-center gap-3 px-3 pt-5 pb-2 text-xs"
                  id={chapterAnchor(source.id, chapterIndex)}
                >
                  <span className="text-foreground font-medium">
                    {chapter.title}
                  </span>
                  <span className="tabular-nums">
                    {next
                      ? `${label(chapter.at)} – ${label(next.at)}`
                      : label(chapter.at)}
                  </span>
                  <span className="bg-border h-px flex-1" />
                </div>
              ) : null}
              <div className={turnClass(isActive, continues)}>
                <span className="text-muted-foreground text-xs leading-6 tabular-nums">
                  {label(turn.at)}
                </span>
                <span className="text-xs leading-6">
                  {continues && !isActive ? null : (
                    <span
                      className={`rounded-md box-decoration-clone px-1.5 py-0.5 ${voiceTint(turn.speaker)}`}
                    >
                      {turn.speaker}
                    </span>
                  )}
                </span>
                <p>
                  <TurnText
                    current={hit}
                    highlights={own}
                    hits={turnHits}
                    length={needleLength}
                    text={turn.text}
                  />
                </p>
              </div>
            </div>
          );
        })}
        {filtering && !turns.some((_, index) => visible(index)) ? (
          <p className="text-muted-foreground px-3 py-6 text-sm">
            <Trans>Nothing here matches the filter.</Trans>
          </p>
        ) : null}
      </div>
    </section>
  );
};

/**
 * A document as a page to read, like a note in Notion: its headings and its text, with the
 * statements tagged in it highlighted where they are written. No numbers, speakers or tools: a
 * document is read, not searched turn by turn. The statement in the address is scrolled into view.
 */
export const DocumentView = ({
  source,
  statements,
  activeId,
}: {
  source: TranscribedSource;
  statements: Statement[];
  activeId?: string | undefined;
}) => {
  const { turns, chapters } = source.transcript;
  const highlights = highlightsOf(source, statements);
  const chapterOf = chapterOfTurns(source.transcript);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeId === undefined) {
      return;
    }
    box.current
      ?.querySelector(`[data-statement="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [activeId]);

  return (
    <div
      className="flex flex-col gap-3 border-t pt-6 text-sm leading-7"
      ref={box}
    >
      {turns.map((turn, index) => {
        const chapterIndex = chapterOf[index] ?? 0;
        const opensChapter =
          index === 0 || chapterIndex !== chapterOf[index - 1];
        const chapter = chapters[chapterIndex];
        const own = highlights.filter((highlight) => highlight.turn === index);
        const isActive = own.some(
          (highlight) => highlight.statement.id === activeId
        );
        return (
          <div className="contents" key={`${turn.at}-${index}`}>
            {opensChapter && chapter ? (
              <h2
                className={
                  index === 0
                    ? "scroll-mt-4 font-medium"
                    : "scroll-mt-4 pt-3 font-medium"
                }
                id={chapterAnchor(source.id, chapterIndex)}
              >
                {chapter.title}
              </h2>
            ) : null}
            <p
              className={
                isActive ? "ring-foreground -mx-2 rounded-lg px-2 ring-2" : ""
              }
            >
              <TurnText
                current={0}
                highlights={own}
                hits={[]}
                length={0}
                text={turn.text}
              />
            </p>
          </div>
        );
      })}
    </div>
  );
};

/** Where on the strip beside the statements a highlight falls, from the first turn at the top to the last. */
const along = (turn: number, turns: number): string =>
  `${(turn / Math.max(1, turns - 1)) * 96}%`;

/**
 * Beside a transcript: its topics, which scroll to where each starts, and its statements in the
 * order they were said, with a strip that shows where in the transcript each one falls. Beside a
 * document the topics are its contents, without passage numbers: a document is read as a page.
 */
export const TranscriptRail = ({
  source,
  statements,
  activeId,
}: {
  source: TranscribedSource;
  statements: Statement[];
  activeId?: string | undefined;
}) => {
  const { chapters, turns } = source.transcript;
  const isDocument = source.transcript.unit === "passage";
  const label = (at: string): string =>
    isDocument ? "" : placeLabel(source.transcript, at);
  const highlights = highlightsOf(source, statements);
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-1">
        <h2 className="text-muted-foreground flex items-baseline justify-between pb-1 text-sm">
          {isDocument ? (
            <Trans context="heading: the headings of a document, as a table of contents">
              Contents
            </Trans>
          ) : (
            <Trans>Topics</Trans>
          )}
          <span>{chapters.length}</span>
        </h2>
        {chapters.map((chapter, index) => (
          <button
            className="hover:bg-sidebar-accent -mx-2 flex items-baseline justify-between gap-3 rounded-md px-2 py-1 text-left text-sm"
            key={chapter.at}
            onClick={() => {
              document
                .querySelector(
                  `#${CSS.escape(chapterAnchor(source.id, index))}`
                )
                ?.scrollIntoView({ block: "start", behavior: "smooth" });
            }}
            type="button"
          >
            <span>{chapter.title}</span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {label(chapter.at)}
            </span>
          </button>
        ))}
      </section>
      {/* A source nobody said anything tagged in, like a vision talk that backs the goals, has no list to show. */}
      {highlights.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-muted-foreground flex items-baseline justify-between text-sm">
            <Trans>Statements</Trans>
            <span>{highlights.length}</span>
          </h2>
          <div className="flex gap-3">
            {/* Where each highlight falls in the conversation, from the first turn at the top to the
                last: drawn rather than placed, as SVG takes a share of its height as a position. */}
            <div
              aria-hidden="true"
              className="bg-sidebar-accent relative w-1.5 flex-none rounded-full"
            >
              <svg className="absolute inset-0 size-full overflow-visible">
                {highlights.map((highlight) => (
                  <rect
                    className={
                      highlight.statement.id === activeId
                        ? "fill-foreground"
                        : "fill-graph-statements"
                    }
                    height="4"
                    key={highlight.statement.id}
                    rx="2"
                    width="14"
                    x="-4"
                    y={along(highlight.turn, turns.length)}
                  />
                ))}
              </svg>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              {highlights.map((highlight) => (
                <Link
                  className={
                    highlight.statement.id === activeId
                      ? "border-foreground bg-background flex flex-col gap-1 rounded-lg border px-2.5 py-2"
                      : "bg-background hover:border-foreground/40 flex flex-col gap-1 rounded-lg border px-2.5 py-2"
                  }
                  hash={highlight.statement.id}
                  hashScrollIntoView={false}
                  key={highlight.statement.id}
                  params={{ noteId: source.id }}
                  to="/brain/$noteId"
                >
                  <span className="flex items-center justify-between gap-2 text-xs">
                    <span
                      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium ${tintClass("statement")}`}
                    >
                      <KindLabel kind={highlight.statement.kind} />
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {label(turns[highlight.turn]?.at ?? "")}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-xs leading-5">
                    {highlight.statement.text}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
};
