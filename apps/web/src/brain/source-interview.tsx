import type {
  Source,
  Statement,
  StatementKind,
  Transcript,
} from "@grasp-os/shared/brain";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import { Button } from "../grasp/button/index.ts";
import { Trash } from "../grasp/icons/index.ts";
import {
  Interview,
  InterviewQuote,
  InterviewTimeline,
  InterviewTranscript,
  useInterview,
} from "../grasp/interview/index.ts";
import type { InterviewKind, InterviewTone } from "../grasp/interview/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { statementKindLabel } from "./brain.ts";
import { kindIcon } from "./statement-kind.tsx";
import { chapterOfTurns, highlightsOf, position } from "./transcript.ts";

// One source's own words on the library's Interview: the transcript with
// its chapters, its search and what was said marked in its margin, the
// conversation as a timeline above it when its turns have times, and
// beside it, each statement as a quote that goes to its moment.

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

/** The milliseconds of "12:26", where a transcript counts in minutes. */
const msOf = (transcript: Transcript, at: string): number | undefined =>
  transcript.unit === "passage" ? undefined : position(at) * 1000;

const styles = stylex.create({
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

/** The conversation: its timeline when its turns have times, then the transcript. */
export const SourceTranscript = () => {
  const timed =
    useInterview()?.turns.some(({ startMs }) => startMs !== undefined) ?? false;
  return (
    <div {...stylex.props(styles.stack)}>
      {timed ? <InterviewTimeline /> : null}
      <InterviewTranscript headingLevel={2} height="min(40rem, 70dvh)" />
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
