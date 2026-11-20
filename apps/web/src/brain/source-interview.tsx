import type {
  Source,
  Statement,
  StatementKind,
  Transcript,
} from "@grasp-os/shared/brain";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { formatList } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { Trash } from "../grasp/icons/index.ts";
import {
  Interview,
  InterviewQuote,
  InterviewTimeline,
  InterviewTranscript,
  MarginPassage,
  MarginProse,
  useInterview,
} from "../grasp/interview/index.ts";
import type { InterviewKind, InterviewTone } from "../grasp/interview/index.ts";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../grasp/tabs/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { statementKindLabel } from "./brain.ts";
import { kindIcon } from "./statement-kind.tsx";
import { chapterOfTurns, highlightsOf, position } from "./transcript.ts";
import type { Highlight } from "./transcript.ts";

// One source's own words on the library's Interview: the transcript with
// its chapters, its search and what was said marked in its margin, the
// conversation as a timeline above it when its turns have times, and
// beside it, each statement as a quote that goes to its moment. A
// document is read as a page instead, its statements in the same margin.

/** A source that has its conversation word for word. */
export type TranscribedSource = Source & { transcript: Transcript };

/**
 * Each kind of statement's one quiet tone. Its pill carries the kind's
 * icon and its word (decision 15: an icon when the kind has one).
 */
const kindTone: Record<StatementKind, InterviewTone> = {
  blocker: "rose",
  timeSink: "amber",
  handover: "violet",
  tool: "sea",
  rule: "neutral",
  wish: "leaf",
  goal: "pine",
};

/** What a CSS anchor name may not hold, out of React's id. */
const notIdent = /[^\w-]/gu;

/** The milliseconds of "12:26", where a transcript counts in minutes. */
const msOf = (transcript: Transcript, at: string): number | undefined =>
  transcript.unit === "passage" ? undefined : position(at) * 1000;

const styles = stylex.create({
  sourceTabs: {
    paddingTop: grasp.space4,
    borderTopWidth: grasp.hairline,
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
  },
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space5,
    minWidth: 0,
  },
  quotes: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space5,
    minWidth: 0,
  },
  quote: {
    display: "flex",
    alignItems: "flex-start",
    gap: grasp.space2,
    minWidth: 0,
  },
  grow: { flexGrow: 1, minWidth: 0 },
  document: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space4,
    minWidth: 0,
  },
  chapter: { marginBlockStart: grasp.space4 },
  // A statement a link may point at, clear of the bar above it.
  passage: { scrollMarginBlockStart: grasp.space24 },
});

/** The statement kinds as Interview takes them: a word, a tone and an icon each. */
const useKinds = (): Record<StatementKind, InterviewKind> => {
  const { i18n } = useLingui();
  const kindOf = (kind: StatementKind): InterviewKind => ({
    label: i18n._(statementKindLabel[kind]),
    tone: kindTone[kind],
    icon: kindIcon[kind],
  });
  return {
    goal: kindOf("goal"),
    blocker: kindOf("blocker"),
    timeSink: kindOf("timeSink"),
    handover: kindOf("handover"),
    tool: kindOf("tool"),
    rule: kindOf("rule"),
    wish: kindOf("wish"),
  };
};

/**
 * Holds one source's conversation for the parts below, wherever on the
 * page they stand. The statement a link opened (`activeId`) is the
 * active turn, and a link to another one makes that one active.
 */
export const SourceInterview = ({
  source,
  statements,
  activeId,
  children,
}: {
  source: TranscribedSource;
  statements: Statement[];
  activeId: string | undefined;
  children: ReactNode;
}) => {
  const kinds = useKinds();
  const { transcript } = source;
  const placed = highlightsOf(source, statements);
  const turnOf = (id: string | undefined): number | null =>
    placed.find(({ statement }) => statement.id === id)?.turn ?? null;
  const [turn, setTurn] = useState(turnOf(activeId));
  const [opened, setOpened] = useState(activeId);
  if (activeId !== opened) {
    setOpened(activeId);
    if (activeId !== undefined) {
      setTurn(turnOf(activeId));
    }
  }
  const chapterOf = chapterOfTurns(transcript);
  return (
    <Interview
      chapters={transcript.chapters.flatMap((chapter, index) => {
        const firstTurn = chapterOf.indexOf(index);
        return firstTurn === -1 ? [] : [{ title: chapter.title, firstTurn }];
      })}
      highlights={placed.map(({ statement, turn: at, start, end }) => ({
        id: statement.id,
        kind: statement.kind,
        turn: at,
        start,
        end,
        text: statement.text,
      }))}
      kinds={kinds}
      onTurnChange={setTurn}
      search
      turn={turn}
      turns={transcript.turns.map(({ speaker, text, at }) => {
        const startMs = msOf(transcript, at);
        return startMs === undefined
          ? { speaker, text }
          : { speaker, text, startMs };
      })}
    >
      {children}
    </Interview>
  );
};

/** The conversation: its timeline, then the transcript (every turn of a conversation has its time). */
export const SourceTranscript = () => (
  <div {...stylex.props(styles.stack)}>
    <InterviewTimeline />
    <InterviewTranscript headingLevel={2} height="min(40rem, 70dvh)" />
  </div>
);

/**
 * A conversation's page: its summary, and the whole conversation word for word with its statements
 * highlighted. It opens on the transcript, and a link to a statement always brings it there.
 */
export const SourceTabs = ({
  activeId,
  children,
}: {
  activeId: string | undefined;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const [tab, setTab] = useState("transcript");
  const [opened, setOpened] = useState(activeId);
  // A quote at the side that goes to its moment brings the transcript back too.
  const asked = useInterview()?.asked ?? 0;
  const [seen, setSeen] = useState(asked);
  if (asked !== seen) {
    setSeen(asked);
    setTab("transcript");
  }
  // A link to another statement opens the transcript again, even after the reader went to the summary.
  if (activeId !== opened) {
    setOpened(activeId);
    if (activeId !== undefined) {
      setTab("transcript");
    }
  }
  return (
    <div {...stylex.props(styles.sourceTabs)}>
      <Tabs
        onValueChange={(value) => {
          if (value !== null) {
            setTab(value);
          }
        }}
        value={tab}
      >
        <TabsList>
          <TabsTrigger value="summary">
            {t({
              message: "Summary",
              context: "tab: an interview written up short",
            })}
          </TabsTrigger>
          <TabsTrigger value="transcript">
            {t({
              message: "Transcript",
              context: "tab: the whole conversation word for word",
            })}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="summary">{children}</TabsContent>
        <TabsContent value="transcript">
          <SourceTranscript />
        </TabsContent>
      </Tabs>
    </div>
  );
};

/**
 * Beside the conversation: what was said in it, in the order it was said,
 * each a quote whose citation goes to its moment, with a way to take it
 * out of the brain for whoever may.
 */
export const SourceQuotes = ({
  source,
  statements,
  onRemove,
}: {
  source: TranscribedSource;
  statements: Statement[];
  /** Takes one thing that was said out of the brain, for whoever may. */
  onRemove: ((statement: Statement) => void) | undefined;
}) => {
  const { t, i18n } = useLingui();
  return (
    <div {...stylex.props(styles.quotes)}>
      {highlightsOf(source, statements).map(({ statement, turn }) => (
        <div key={statement.id} {...stylex.props(styles.quote)}>
          <InterviewQuote
            kind={i18n._(statementKindLabel[statement.kind])}
            layout={styles.grow}
            size="sm"
            tone={kindTone[statement.kind]}
            turn={turn}
          >
            {statement.text}
          </InterviewQuote>
          {onRemove === undefined ? null : (
            <Button
              aria-label={t`Remove this from the brain`}
              icon={Trash}
              onClick={() => {
                onRemove(statement);
              }}
              size="xs"
              variant="ghost"
            />
          )}
        </div>
      ))}
    </div>
  );
};

/**
 * A document as a page to read: its headings and its passages, with what
 * was said in it beside its lines in the margin, the kind's word at each.
 * A link to a statement (its id) brings it into view.
 */
export const SourceDocument = ({
  source,
  statements,
}: {
  source: TranscribedSource;
  statements: Statement[];
}) => {
  const { i18n } = useLingui();
  const { turns, chapters } = source.transcript;
  const chapterOf = chapterOfTurns(source.transcript);
  const own = useId().replaceAll(notIdent, "");
  // Its passages in order, each with its own note under the one before when
  // the two would meet, so one margin holds them all. A statement that starts
  // inside the passage before it is read there: its kind joins the note and
  // its id stands at that passage, so a link to it still lands.
  const passages: (Highlight & {
    also: Statement[];
    name: string;
    after: string | undefined;
  })[] = [];
  for (const each of highlightsOf(source, statements)) {
    const last = passages.at(-1);
    if (last?.turn === each.turn && each.start < last.end) {
      last.also.push(each.statement);
      continue;
    }
    passages.push({
      ...each,
      also: [],
      name: `--document-${own}-note-${passages.length}`,
      after: last?.name,
    });
  }
  return (
    <MarginProse>
      <div {...stylex.props(styles.document)}>
        {turns.map((turn, index) => {
          const chapter = chapters[chapterOf[index] ?? 0];
          const opens =
            index === 0 || chapterOf[index] !== chapterOf[index - 1];
          let from = 0;
          const pieces: ReactNode[] = [];
          for (const passage of passages.filter(
            (each) => each.turn === index
          )) {
            pieces.push(
              turn.text.slice(from, passage.start),
              ...passage.also.map(({ id }) => (
                <span id={id} key={id} {...stylex.props(styles.passage)} />
              )),
              <span
                id={passage.statement.id}
                key={passage.statement.id}
                {...stylex.props(styles.passage)}
              >
                <MarginPassage
                  after={passage.after}
                  name={passage.name}
                  note={formatList([
                    ...new Set(
                      [passage.statement, ...passage.also].map(({ kind }) =>
                        i18n._(statementKindLabel[kind])
                      )
                    ),
                  ])}
                >
                  {turn.text.slice(passage.start, passage.end)}
                </MarginPassage>
              </span>
            );
            from = passage.end;
          }
          pieces.push(turn.text.slice(from));
          return (
            <div key={`${turn.at}-${index}`} {...stylex.props(styles.document)}>
              {opens && chapter !== undefined ? (
                <Heading layout={styles.chapter} level={2} size="ui">
                  {chapter.title}
                </Heading>
              ) : null}
              <Text>{pieces}</Text>
            </div>
          );
        })}
      </div>
    </MarginProse>
  );
};
