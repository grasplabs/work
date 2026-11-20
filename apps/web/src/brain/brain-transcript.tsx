import type {
  Source,
  Statement,
  StatementKind,
  Transcript,
} from "@grasp-os/shared/brain";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import { focus } from "../grasp/focus/focus.ts";
import {
  ChevronDown,
  ChevronUp,
  Cross,
  Search,
  Sliders,
  Trash,
} from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { brainMarks, tintOf } from "./brain-chips.tsx";
import { statementKindLabel } from "./brain.ts";
import { KindLabel } from "./statement-kind.tsx";
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
  tintOf("team"),
  tintOf("tool"),
  tintOf("vision"),
  tintOf("candidate"),
  tintOf("gap"),
];

const styles = stylex.create({
  // What was marked in a turn: the statements' soft fill, its ends rounded where it opens and closes.
  marked: {
    scrollMarginTop: grasp.space24,
    boxDecorationBreak: "clone",
    paddingBlock: 2,
  },
  opens: {
    paddingInlineStart: grasp.space1,
    borderStartStartRadius: grasp.cornerMark,
    borderEndStartRadius: grasp.cornerMark,
  },
  closes: {
    paddingInlineEnd: grasp.space1,
    borderStartEndRadius: grasp.cornerMark,
    borderEndEndRadius: grasp.cornerMark,
  },
  markKind: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    marginInlineEnd: grasp.space2,
    verticalAlign: "middle",
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
  },
  markRemove: {
    display: "inline-flex",
    marginInlineStart: grasp.space1,
    verticalAlign: "middle",
  },
  tools: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
  },
  search: {
    width: `calc(3.5 * ${grasp.space16})`,
    maxWidth: "100%",
  },
  matches: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
  },
  filter: { marginInlineStart: "auto" },
  transcript: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
  },
  turns: {
    display: "flex",
    flexDirection: "column",
  },
  turnHolder: {
    display: "flex",
    flexDirection: "column",
  },
  chapter: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    scrollMarginTop: grasp.space4,
    paddingInline: grasp.space3,
    paddingTop: grasp.space5,
    paddingBottom: grasp.space2,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  chapterTitle: {
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  numbers: { fontVariantNumeric: "tabular-nums" },
  rule: {
    flexGrow: 1,
    height: 1,
    backgroundColor: grasp.line,
  },
  // A turn: when, who, and the words, in three columns that wrap at a phone's width.
  turn: {
    display: "grid",
    gridTemplateColumns: `${grasp.space12} minmax(0, calc(2.25 * ${grasp.space16})) minmax(0, 1fr)`,
    columnGap: grasp.space4,
    paddingInline: grasp.space3,
    paddingTop: grasp.space3,
    paddingBottom: grasp.space1,
    borderRadius: grasp.corner,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.text,
  },
  // Someone who says several things in a row is named once: the next turn sits close.
  continues: { paddingTop: 2 },
  // The turn a link opened.
  activeTurn: {
    paddingBlock: grasp.space3,
    backgroundColor: grasp.paper,
    boxShadow: `0 0 0 2px ${grasp.ink}`,
  },
  at: {
    fontSize: grasp.textXs,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
  },
  speakerCell: {
    fontSize: grasp.textXs,
    lineHeight: grasp.textSmLine,
  },
  speaker: {
    boxDecorationBreak: "clone",
    paddingBlock: 2,
    paddingInline: grasp.space2,
    borderRadius: grasp.cornerMark,
  },
  grasp: {
    backgroundColor: grasp.soft,
    color: grasp.muted,
  },
  words: { margin: 0 },
  nothing: {
    margin: 0,
    paddingInline: grasp.space3,
    paddingBlock: grasp.space6,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  document: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
    paddingTop: grasp.space6,
    borderTopWidth: grasp.hairline,
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
    fontSize: grasp.textSm,
    lineHeight: 1.75,
    color: grasp.text,
  },
  passageHolder: { display: "contents" },
  passageHeading: {
    margin: 0,
    scrollMarginTop: grasp.space4,
    fontSize: grasp.textSm,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  passageHeadingLater: { paddingTop: grasp.space3 },
  passage: { margin: 0 },
  activePassage: {
    marginInline: `calc(-1 * ${grasp.space2})`,
    paddingInline: grasp.space2,
    borderRadius: grasp.corner,
    boxShadow: `0 0 0 2px ${grasp.ink}`,
  },
  rail: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space5,
  },
  topics: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
  },
  railHeading: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    margin: 0,
    paddingBottom: grasp.space1,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightRegular,
    color: grasp.muted,
  },
  topic: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: grasp.space3,
    marginInline: `calc(-1 * ${grasp.space2})`,
    paddingBlock: grasp.space1,
    paddingInline: grasp.space2,
    borderWidth: 0,
    borderRadius: grasp.cornerMark,
    backgroundColor: { default: "transparent", ":hover": grasp.ghostFillHover },
    color: grasp.ink,
    fontFamily: "inherit",
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    textAlign: "start",
    cursor: "pointer",
  },
  topicAt: {
    flexShrink: 0,
    fontSize: grasp.textXs,
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
  },
  said: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
  },
  saidRow: {
    display: "flex",
    gap: grasp.space3,
  },
  // Where each highlight falls in the conversation, from the first turn at the top to the last.
  strip: {
    position: "relative",
    flexShrink: 0,
    width: 6,
    borderRadius: grasp.cornerPill,
    backgroundColor: grasp.soft,
  },
  stripDrawing: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    overflow: "visible",
  },
  cards: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    gap: grasp.space2,
    minWidth: 0,
  },
  cardHolder: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    paddingBlock: grasp.space2,
    paddingInline: grasp.space3,
    borderRadius: grasp.corner,
    backgroundColor: grasp.paper,
    boxShadow: { default: grasp.edge, ":hover": `0 0 0 1px ${grasp.muted}` },
    color: grasp.ink,
    textDecorationLine: "none",
  },
  activeCard: {
    boxShadow: `0 0 0 1px ${grasp.ink}`,
  },
  cardHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space2,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
  cardKind: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    paddingBlock: 2,
    paddingInline: grasp.space2,
    borderRadius: grasp.cornerMark,
    fontWeight: grasp.weightMedium,
  },
  cardAt: {
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
  },
  cardWords: {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    overflow: "hidden",
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
  cardRemove: {
    position: "absolute",
    insetInlineEnd: grasp.space1,
    insetBlockEnd: grasp.space1,
  },
});

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
const hitMark = (hit: number | undefined, current: number) => {
  if (hit === undefined) {
    return null;
  }
  return hit === current ? brainMarks.hitCurrent : brainMarks.hit;
};

/** A turn's words: highlights in the statements' colour with their kind in front, search hits marked. */
const TurnText = ({
  text,
  highlights,
  hits,
  length,
  current,
  onRemove,
}: {
  text: string;
  highlights: Highlight[];
  hits: { start: number; index: number }[];
  length: number;
  current: number;
  onRemove?: ((statement: Statement) => void) | undefined;
}) => {
  const { t } = useLingui();
  const parts = turnParts(text, highlights, hits, length);
  return (
    <>
      {parts.map((part, index) => {
        const opens =
          part.statement !== undefined &&
          parts[index - 1]?.statement !== part.statement;
        const body = (
          <span
            data-hit={part.hit}
            {...stylex.props(hitMark(part.hit, current))}
          >
            {part.text}
          </span>
        );
        if (!part.statement) {
          return <span key={index}>{body}</span>;
        }
        const { statement } = part;
        const closes = parts[index + 1]?.statement !== statement;
        return (
          <span
            data-statement={opens ? part.statement.id : undefined}
            key={index}
            {...stylex.props(
              styles.marked,
              tintOf("statement"),
              opens && styles.opens,
              closes && styles.closes
            )}
          >
            {opens ? (
              <span {...stylex.props(styles.markKind)}>
                <KindLabel kind={part.statement.kind} />
              </span>
            ) : null}
            {body}
            {/* At the end of what was marked: the way to take it out of the brain. */}
            {onRemove !== undefined && closes ? (
              <span {...stylex.props(styles.markRemove)}>
                <Button
                  aria-label={t`Remove this from the brain`}
                  icon={Trash}
                  onClick={() => {
                    onRemove(statement);
                  }}
                  size="xs"
                  title={t`Remove from the brain`}
                  variant="ghost"
                />
              </span>
            ) : null}
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
  const { t, i18n } = useLingui();
  const [open, setOpen] = useState(false);
  const said = kindOrder.filter((kind) =>
    highlights.some((highlight) => highlight.statement.kind === kind)
  );
  const active = kinds.length + (onlyHighlights ? 1 : 0);
  return (
    <span {...stylex.props(styles.tools)}>
      <DropdownMenu onOpenChange={setOpen} open={open}>
        <DropdownMenuTrigger icon={Sliders} size="sm">
          {t({ message: "Filter", context: "open the filters" })}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t`Kind of statement`}</DropdownMenuLabel>
            {said.map((kind) => {
              const name = i18n._(statementKindLabel[kind]);
              const count = highlights.filter(
                (highlight) => highlight.statement.kind === kind
              ).length;
              return (
                <DropdownMenuCheckboxItem
                  checked={kinds.includes(kind)}
                  key={kind}
                  onCheckedChange={(checked) => {
                    onKindsChange(
                      checked
                        ? [...kinds, kind]
                        : kinds.filter((each) => each !== kind)
                    );
                  }}
                >
                  {t({
                    message: `${name} (${count})`,
                    comment:
                      "A kind of statement in the transcript's filter, and how many of that kind were said",
                  })}
                </DropdownMenuCheckboxItem>
              );
            })}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuCheckboxItem
              checked={onlyHighlights}
              onCheckedChange={(checked) => {
                onOnlyHighlightsChange(checked);
              }}
            >
              {t`Only highlighted turns`}
            </DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
          {active > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  icon={Cross}
                  onSelect={() => {
                    onKindsChange([]);
                    onOnlyHighlightsChange(false);
                  }}
                >
                  {t`Clear filters`}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* How many filters are on, beside the button that sets them. */}
      {active > 0 ? <Badge size="sm">{active}</Badge> : null}
    </span>
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
const turnLook = (isActive: boolean, continues: boolean) => {
  if (isActive) {
    return styles.activeTurn;
  }
  return continues ? styles.continues : null;
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
  onRemove,
}: {
  source: TranscribedSource;
  statements: Statement[];
  activeId?: string | undefined;
  /** Takes one marked passage out of the brain, for whoever may. */
  onRemove?: ((statement: Statement) => void) | undefined;
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
  const voiceTint = (speaker: string) =>
    isGrasp(speaker)
      ? styles.grasp
      : (voiceTints[people.indexOf(speaker) % voiceTints.length] ?? null);
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
    <div {...stylex.props(styles.tools)}>
      <Input
        aria-label={search}
        icon={Search}
        layout={styles.search}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            step(event.shiftKey ? -1 : 1);
          }
        }}
        onValueChange={(value) => {
          setQuery(value);
          setCurrent(0);
        }}
        placeholder={search}
        size="sm"
        type="search"
        value={query}
      />
      {needleLength >= 2 ? (
        <span aria-live="polite" {...stylex.props(styles.matches)}>
          {hits.length === 0 ? (
            <Trans>No matches</Trans>
          ) : (
            <Trans>
              {match} of {matches}
            </Trans>
          )}
          <Button
            aria-label={t`Previous match`}
            icon={ChevronUp}
            onClick={() => {
              step(-1);
            }}
            size="sm"
            variant="ghost"
          />
          <Button
            aria-label={t`Next match`}
            icon={ChevronDown}
            onClick={() => {
              step(1);
            }}
            size="sm"
            variant="ghost"
          />
        </span>
      ) : null}
      <div {...stylex.props(styles.filter)}>
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
    <section {...stylex.props(styles.transcript)}>
      {placed(tools, toolbarIn)}

      <div ref={box} {...stylex.props(styles.turns)}>
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
            <div
              key={`${turn.at}-${index}`}
              {...stylex.props(styles.turnHolder)}
            >
              {opensChapter && chapter ? (
                <div
                  id={chapterAnchor(source.id, chapterIndex)}
                  {...stylex.props(styles.chapter)}
                >
                  <span {...stylex.props(styles.chapterTitle)}>
                    {chapter.title}
                  </span>
                  <span {...stylex.props(styles.numbers)}>
                    {next
                      ? `${label(chapter.at)} – ${label(next.at)}`
                      : label(chapter.at)}
                  </span>
                  <span aria-hidden="true" {...stylex.props(styles.rule)} />
                </div>
              ) : null}
              <div
                {...stylex.props(styles.turn, turnLook(isActive, continues))}
              >
                <span {...stylex.props(styles.at)}>{label(turn.at)}</span>
                <span {...stylex.props(styles.speakerCell)}>
                  {continues && !isActive ? null : (
                    <span
                      {...stylex.props(styles.speaker, voiceTint(turn.speaker))}
                    >
                      {turn.speaker}
                    </span>
                  )}
                </span>
                <p {...stylex.props(styles.words)}>
                  <TurnText
                    current={hit}
                    highlights={own}
                    hits={turnHits}
                    length={needleLength}
                    onRemove={onRemove}
                    text={turn.text}
                  />
                </p>
              </div>
            </div>
          );
        })}
        {filtering && !turns.some((_, index) => visible(index)) ? (
          <p {...stylex.props(styles.nothing)}>
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
    <div ref={box} {...stylex.props(styles.document)}>
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
          <div
            key={`${turn.at}-${index}`}
            {...stylex.props(styles.passageHolder)}
          >
            {opensChapter && chapter ? (
              <h2
                id={chapterAnchor(source.id, chapterIndex)}
                {...stylex.props(
                  styles.passageHeading,
                  index > 0 && styles.passageHeadingLater
                )}
              >
                {chapter.title}
              </h2>
            ) : null}
            <p
              {...stylex.props(
                styles.passage,
                isActive && styles.activePassage
              )}
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
  onRemove,
}: {
  source: TranscribedSource;
  statements: Statement[];
  activeId?: string | undefined;
  /** Takes one thing that was said out of the brain, for whoever may. */
  onRemove?: ((statement: Statement) => void) | undefined;
}) => {
  const { t } = useLingui();
  const { chapters, turns } = source.transcript;
  const isDocument = source.transcript.unit === "passage";
  const label = (at: string): string =>
    isDocument ? "" : placeLabel(source.transcript, at);
  const highlights = highlightsOf(source, statements);
  return (
    <div {...stylex.props(styles.rail)}>
      <section {...stylex.props(styles.topics)}>
        <h2 {...stylex.props(styles.railHeading)}>
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
            key={chapter.at}
            onClick={() => {
              document
                .querySelector(
                  `#${CSS.escape(chapterAnchor(source.id, index))}`
                )
                ?.scrollIntoView({ block: "start", behavior: "smooth" });
            }}
            type="button"
            {...stylex.props(styles.topic, focus.ring)}
          >
            <span>{chapter.title}</span>
            <span {...stylex.props(styles.topicAt)}>{label(chapter.at)}</span>
          </button>
        ))}
      </section>
      {/* A source nobody said anything tagged in, like a vision talk that backs the goals, has no list to show. */}
      {highlights.length > 0 ? (
        <section {...stylex.props(styles.said)}>
          <h2 {...stylex.props(styles.railHeading)}>
            <Trans>Statements</Trans>
            <span>{highlights.length}</span>
          </h2>
          <div {...stylex.props(styles.saidRow)}>
            {/* Where each highlight falls in the conversation, from the first turn at the top to the
                last: drawn rather than placed, as SVG takes a share of its height as a position. */}
            <div aria-hidden="true" {...stylex.props(styles.strip)}>
              <svg {...stylex.props(styles.stripDrawing)}>
                {highlights.map((highlight) => (
                  <rect
                    {...stylex.props(
                      highlight.statement.id === activeId
                        ? brainMarks.stripMarkActive
                        : brainMarks.stripMark
                    )}
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
            <div {...stylex.props(styles.cards)}>
              {highlights.map((highlight) => (
                <div
                  key={highlight.statement.id}
                  {...stylex.props(styles.cardHolder)}
                >
                  <Link
                    hash={highlight.statement.id}
                    hashScrollIntoView={false}
                    params={{ noteId: source.id }}
                    to="/brain/$noteId"
                    {...stylex.props(
                      styles.card,
                      highlight.statement.id === activeId && styles.activeCard,
                      focus.ring
                    )}
                  >
                    <span {...stylex.props(styles.cardHead)}>
                      <span
                        {...stylex.props(styles.cardKind, tintOf("statement"))}
                      >
                        <KindLabel kind={highlight.statement.kind} />
                      </span>
                      <span {...stylex.props(styles.cardAt)}>
                        {label(turns[highlight.turn]?.at ?? "")}
                      </span>
                    </span>
                    <span {...stylex.props(styles.cardWords)}>
                      {highlight.statement.text}
                    </span>
                  </Link>
                  {onRemove === undefined ? null : (
                    <Button
                      aria-label={t`Remove this from the brain`}
                      icon={Trash}
                      layout={styles.cardRemove}
                      onClick={() => {
                        onRemove(highlight.statement);
                      }}
                      size="xs"
                      title={t`Remove from the brain`}
                      variant="ghost"
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
};
