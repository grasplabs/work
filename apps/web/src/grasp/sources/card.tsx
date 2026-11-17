// SourceCard: what a marker's card shows (citation.tsx), one frame for every kind: the mark and
// where it lives, its title, then the part the answer used, set as the kind needs it. The quoted
// passage is set in Geist Serif with a mint mark: the proof is the one thing in focus. Built from
// finished parts: Key value rows for a record's fields, Avatar for people, Agent activity for an
// agent's steps, Stepper for a workflow, Table for a peek of rows, Code block for code.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { AgentActivity } from "../agent-activity";
import { Avatar, AvatarImage, AvatarFallback } from "../avatar";
import { Badge } from "../badge";
import { CodeBlock } from "../code-block";
import { focus } from "../focus/focus";
import { Icon, Lock } from "../icons";
import { KeyValueList } from "../key-value";
import { Stepper } from "../stepper";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../table";
import { SourceTile } from "./mark";
import { accessOf, hasWords, kindOf } from "./source";
import { sourceStyles as styles } from "./styles";
import type { Source, SourcesLabels } from "./types";

interface CardProps {
  source: Source;
  labels: SourcesLabels;
  /** Runs when its link to a run is pressed: the page's `onOpen` for this source. */
  onOpen?: () => void;
}

/** The quoted passage: Geist Serif with its mint mark. */
const Passage = ({ words }: { words: string }) => (
  <blockquote
    data-slot="source-passage"
    {...stylex.props(styles.passage, styles.passageBar)}
  >
    {words}
  </blockquote>
);

/** A quiet line before or after the passage, so it reads in its context. */
const Quiet = ({ words }: { words: string | undefined }) =>
  hasWords(words) ? <p {...stylex.props(styles.cardQuiet)}>{words}</p> : null;

/** The passage between its context: a file, a page, a message, a memory, what a person said. */
const InContext = ({ source }: { source: Source }) =>
  hasWords(source.quote) ? (
    <>
      <Quiet words={source.context?.before} />
      <Passage words={source.quote} />
      <Quiet words={source.context?.after} />
    </>
  ) : null;

/** A row of portraits: a meeting's people. */
const People = ({ people }: { people: Source["people"] }) =>
  people !== undefined && people.length > 0 ? (
    <span {...stylex.props(styles.people)}>
      {people.slice(0, 5).map((person, index) => (
        <span
          key={person.name}
          {...stylex.props(styles.person, index === 0 && styles.personFirst)}
        >
          <Avatar name={person.name} size="xs">
            <AvatarImage src={person.src} />
            <AvatarFallback />
          </Avatar>
        </span>
      ))}
    </span>
  ) : null;

/** A meeting's lines, the one quoted marked as a passage. */
const Transcript = ({ source }: { source: Source }) => (
  <ul {...stylex.props(styles.transcript)}>
    {(source.transcript ?? []).map((line) =>
      line.quoted === true ? (
        <li key={`${line.time}-${line.who}`}>
          <Passage words={line.line} />
          <span {...stylex.props(styles.cardQuiet)}>
            {line.time} · {line.who}
          </span>
        </li>
      ) : (
        <li
          key={`${line.time}-${line.who}`}
          {...stylex.props(styles.transcriptLine)}
        >
          <span {...stylex.props(styles.transcriptTime)}>{line.time}</span>
          <span>
            <span {...stylex.props(styles.transcriptWho)}>{line.who}</span>{" "}
            {line.line}
          </span>
        </li>
      )
    )}
  </ul>
);

/** Who sent a message, and when. */
const Sayer = ({ source }: { source: Source }) =>
  source.person === undefined ? null : (
    <span {...stylex.props(styles.sayer)}>
      <Avatar name={source.person.name} size="xs" decorative>
        <AvatarImage src={source.person.src} />
        <AvatarFallback />
      </Avatar>
      <span {...stylex.props(styles.sayerName)}>{source.person.name}</span>
      {hasWords(source.when) ? source.when : null}
    </span>
  );

/** A table's peek: its columns and up to three rows. */
const Peek = ({ peek }: { peek: NonNullable<Source["peek"]> }) => (
  <Table>
    <TableHeader>
      <TableRow>
        {peek.columns.map((column) => (
          <TableHead key={column}>{column}</TableHead>
        ))}
      </TableRow>
    </TableHeader>
    <TableBody>
      {peek.rows.slice(0, 3).map((row) => (
        <TableRow key={row.join("·")}>
          {row.map((cell, index) => (
            <TableCell key={`${peek.columns[index] ?? index}`}>
              {cell}
            </TableCell>
          ))}
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

interface CardLinkProps {
  href: string | undefined;
  words: string;
  /** Runs when it is pressed; with no `href` the link is then a button. */
  onOpen?: () => void;
}

/** A link from the card: to an agent's or a workflow's run, or to correct a memory. */
const CardLink = ({ href, words, onOpen }: CardLinkProps) => {
  if (hasWords(href)) {
    return (
      <a
        href={href}
        data-slot="source-open"
        onClick={onOpen}
        {...stylex.props(styles.cardLink, focus.words)}
      >
        {words}
      </a>
    );
  }
  return onOpen === undefined ? null : (
    <button
      type="button"
      data-slot="source-open"
      onClick={onOpen}
      {...stylex.props(styles.cardLink, styles.titleButton, focus.words)}
    >
      {words}
    </button>
  );
};

/** What the card holds under its title, by kind. */
const Inside = ({ source, labels, onOpen }: CardProps) => {
  const kind = kindOf(source);
  if (kind === "record") {
    return source.fields === undefined ? (
      <InContext source={source} />
    ) : (
      <KeyValueList items={source.fields} variant="inline" />
    );
  }
  if (kind === "message") {
    return (
      <>
        <Sayer source={source} />
        <InContext source={source} />
      </>
    );
  }
  if (kind === "meeting") {
    return (
      <>
        <People people={source.people} />
        <Transcript source={source} />
      </>
    );
  }
  if (kind === "agent") {
    return (
      <>
        <InContext source={source} />
        {source.steps === undefined ? null : (
          <AgentActivity steps={[...source.steps]} />
        )}
        <CardLink href={source.href} words={labels.openRun} onOpen={onOpen} />
      </>
    );
  }
  if (kind === "workflow") {
    return (
      <>
        {source.runState === undefined ? null : (
          <Badge tone={source.runState.tone}>{source.runState.label}</Badge>
        )}
        {source.flow === undefined ? null : (
          <Stepper
            steps={source.flow}
            value={source.usedStep ?? 0}
            orientation="vertical"
            aria-label={source.title}
          />
        )}
        <InContext source={source} />
        <CardLink href={source.href} words={labels.openRun} onOpen={onOpen} />
      </>
    );
  }
  if (kind === "table") {
    return (
      <>
        <InContext source={source} />
        {source.peek === undefined ? null : <Peek peek={source.peek} />}
      </>
    );
  }
  if (kind === "memory") {
    return (
      <>
        <InContext source={source} />
        {source.fields === undefined ? null : (
          <KeyValueList items={source.fields} variant="inline" />
        )}
        <CardLink href={source.href} words={labels.correct} />
      </>
    );
  }
  if (kind === "code" && source.code !== undefined) {
    return (
      <CodeBlock
        code={source.code.text}
        language={source.code.language}
        marked={
          source.code.marked === undefined ? undefined : [...source.code.marked]
        }
        fileName={source.origin}
        lineNumbers
      />
    );
  }
  return <InContext source={source} />;
};

/** The card's head: the mark, where it lives, and when. */
const Head = ({ source }: { source: Source }) => (
  <span {...stylex.props(styles.cardHead)}>
    <SourceTile source={source} size="pile" />
    <span>
      {source.origin}
      {hasWords(source.when) && kindOf(source) !== "message"
        ? ` · ${source.when}`
        : null}
    </span>
  </span>
);

/** Why it cannot be opened, said plainly. */
const Closed = ({
  source,
  labels,
}: {
  source: Source;
  labels: SourcesLabels;
}) => {
  const gone = accessOf(source) === "gone";
  const words: ReactNode = gone ? labels.gone : labels.locked;
  return (
    <p {...stylex.props(styles.cardNote, gone && styles.gone)}>
      {accessOf(source) === "locked" ? (
        <span {...stylex.props(styles.lock)}>
          <Icon icon={Lock} />
        </span>
      ) : null}{" "}
      {words}
      {hasWords(source.reason) ? `: ${source.reason}` : null}
    </p>
  );
};

/** One source's card: the same frame for every kind, the inside as the kind needs it. */
export const SourceCard = ({ source, labels, onOpen }: CardProps) => {
  const open = accessOf(source) === "open";
  return (
    <span
      data-slot="source-card"
      data-kind={kindOf(source)}
      {...stylex.props(styles.card)}
    >
      <Head source={source} />
      <span {...stylex.props(styles.cardTitle)}>{source.title}</span>
      {open ? (
        <Inside source={source} labels={labels} onOpen={onOpen} />
      ) : (
        <Closed source={source} labels={labels} />
      )}
      {open && hasWords(source.place) ? (
        <p {...stylex.props(styles.cardNote)}>{source.place}</p>
      ) : null}
    </span>
  );
};
