import type { Source, Statement, Workspace } from "@grasp-os/shared/brain";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  createFileRoute,
  Link,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { kernOf } from "../brain/article-kern.ts";
import type { StatementRow } from "../brain/article-kern.ts";
import { BackButton } from "../brain/back-button.tsx";
import { BannerHeader } from "../brain/brain-article/kern.tsx";
import { MentionLinks } from "../brain/brain-article/mention-links.tsx";
import { NoteArticle } from "../brain/brain-article/note-article.tsx";
import type { SideTab } from "../brain/brain-article/note-article.tsx";
import { StatementsByKind } from "../brain/brain-article/statements-by-kind.tsx";
import { TeamWork } from "../brain/brain-article/team-work.tsx";
import { Capped, KindTag, NoteChip } from "../brain/brain-chips.tsx";
import { useBrainData } from "../brain/brain-data.ts";
import { useCompanyText } from "../brain/brain-home.tsx";
import { noteFileName, noteMarkdown } from "../brain/brain-markdown.ts";
import { SourceContentsTable } from "../brain/brain-source-contents.tsx";
import { DocumentView, TranscriptView } from "../brain/brain-transcript.tsx";
import type { TranscribedSource } from "../brain/brain-transcript.tsx";
import {
  given,
  kindLabel,
  mentionParts,
  sourceContents,
  splitTimeline,
  statementWords,
} from "../brain/brain.ts";
import type { Note, NoteEvent, NotePoint, NoteRef } from "../brain/brain.ts";
import { useCanForget, useForget } from "../brain/forget.tsx";
import { nameableFrom, NoteBrainPage, onArticle } from "../brain/note-page.tsx";
import { loadTranscript, withTranscript } from "../brain/note-transcript.ts";
import { placeOf } from "../brain/transcript.ts";
import { labelOf } from "../brain/witness.ts";
import { WorkKnowledgeTab } from "../brain/work-knowledge.tsx";
import { AppLogo } from "../connections/app-logo.tsx";
import { ExportMenu } from "../export/export-menu.tsx";
import { formatDay, formatMonth } from "../format.ts";
import { NotePending } from "../frame/page-skeletons-b.tsx";
import { NotFoundState } from "../frame/page-states.tsx";
import { Button } from "../grasp/button/index.ts";
import { Collapsible } from "../grasp/collapsible/index.ts";
import { focus } from "../grasp/focus/focus.ts";
import { Heading } from "../grasp/heading/index.ts";
import {
  Brain as BrainMark,
  Clock,
  Folder,
  Link as LinkIcon,
  Note as NoteIcon,
  Workflow,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import type {
  PageFact,
  PageOpenQuestion,
} from "../grasp/page-properties/index.ts";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../grasp/tabs/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { NotLoaded } from "../load-from-core.tsx";

// One note, as the prototype has it (`routes/brain/$noteId.tsx`). Where the
// prototype links out of the brain, to a workflow on its Workflows page, a
// policy or a domain, Grasp OS has no such page yet: those names stay
// plain words, and a note's domains are left out, as core gives the brain
// none (brain-rpc.ts).

const styles = stylex.create({
  plain: {
    minWidth: 0,
    paddingBlock: 2,
    overflowWrap: "break-word",
  },
  article: {
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
  paragraph: { margin: 0 },
  // The page scrolls on its own, clear of the chat's box at the card's foot.
  page: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingInline: { default: grasp.space6, [media.fromTablet]: grasp.space12 },
    paddingBlockEnd: grasp.space24,
  },
  // What the note holds beyond its text, in the page's reading column (page-brain's own measure,
  // its gutter's room before it on a wider window).
  rest: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space8,
    boxSizing: "border-box",
    width: "100%",
    maxWidth: {
      default: `calc(44rem + ${grasp.space16})`,
      [media.belowPhone]: "44rem",
    },
    marginInline: "auto",
    paddingInlineStart: { default: grasp.space16, [media.belowPhone]: 0 },
  },
  eventTitle: {
    color: "inherit",
    textDecorationLine: { default: "none", ":hover": "underline" },
  },
  // A moment on the timeline: its day, then a line down the side and what happened.
  event: {
    display: "grid",
    gridTemplateColumns: `calc(1.375 * ${grasp.space16}) minmax(0, 1fr)`,
    gap: grasp.space3,
  },
  day: {
    fontSize: grasp.textXs,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  happened: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    paddingBottom: grasp.space3,
    paddingInlineStart: grasp.space3,
    borderInlineStartWidth: 2,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: grasp.line,
  },
  // A moment the note itself was part of.
  ownEvent: { borderInlineStartColor: grasp.ink },
  // What has not happened yet: a dashed line.
  openEvent: {
    borderInlineStartStyle: "dashed",
    color: grasp.muted,
  },
  eventDetail: {
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  timeline: {
    display: "flex",
    flexDirection: "column",
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.text,
  },
  month: {
    display: "flex",
    flexDirection: "column",
  },
  monthName: {
    margin: 0,
    paddingBottom: grasp.space2,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  earlier: { paddingBottom: grasp.space2 },
  details: {
    display: "flex",
    flexDirection: "column",
  },
  detail: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    paddingBlock: grasp.space4,
    borderTopWidth: grasp.hairline,
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
    ":first-child": { paddingTop: 0, borderTopWidth: 0 },
  },
  toolbar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: grasp.space4,
    rowGap: grasp.space2,
  },
  toolbarSide: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
  },
  workTabs: {
    boxSizing: "border-box",
    width: "100%",
    maxWidth: `calc(16 * ${grasp.space16})`,
    marginInline: "auto",
    paddingInline: grasp.space6,
    paddingTop: grasp.space4,
  },
  knowledge: { paddingInline: grasp.space6 },
});

/** A name in a property: a chip for a note, or plain words. */
const Ref = ({ value, byId }: { value: NoteRef; byId: Map<string, Note> }) => {
  const target = value.to === undefined ? undefined : byId.get(value.to);
  if (target) {
    return <NoteChip label={value.label} note={target} />;
  }
  return <span {...stylex.props(styles.plain)}>{value.label}</span>;
};

/** Text with the notes it names as chips, each the first time it is named. */
const Mentioned = ({
  text,
  nameable,
  byId,
}: {
  text: string;
  nameable: Note[];
  byId: Map<string, Note>;
}) => (
  <>
    {mentionParts(text, nameable).map((part, index) => {
      if (typeof part === "string") {
        return <span key={index}>{part}</span>;
      }
      const target = byId.get(part.id);
      return target ? (
        <NoteChip key={index} label={part.label} note={target} />
      ) : (
        <span key={index}>{part.label}</span>
      );
    })}
  </>
);

/** An interview's summary: its article, with the notes it names as chips. */
const Article = ({
  paragraphs,
  nameable,
  byId,
}: {
  paragraphs: string[] | undefined;
  nameable: Note[];
  byId: Map<string, Note>;
}) => {
  if (paragraphs === undefined) {
    return null;
  }
  return (
    <section {...stylex.props(styles.article)}>
      {paragraphs.map((paragraph) => (
        <p key={paragraph} {...stylex.props(styles.paragraph)}>
          <Mentioned byId={byId} nameable={nameable} text={paragraph} />
        </p>
      ))}
    </section>
  );
};

const EventTitle = ({ entry }: { entry: NoteEvent }) => {
  if (entry.to !== undefined) {
    return (
      <Link
        params={{ noteId: entry.to }}
        to="/brain/$noteId"
        {...stylex.props(styles.eventTitle, focus.words)}
      >
        {entry.title}
      </Link>
    );
  }
  return <span>{entry.title}</span>;
};

const TimelineEvent = ({ entry }: { entry: NoteEvent }) => {
  const { t } = useLingui();
  const own = entry.own || entry.quotes.some((quote) => quote.own);
  const statements = entry.quotes.length;
  return (
    <div {...stylex.props(styles.event)}>
      <span {...stylex.props(styles.day)}>{formatDay(entry.date)}</span>
      <div {...stylex.props(styles.happened, own && styles.ownEvent)}>
        <EventTitle entry={entry} />
        {given(entry.detail) || statements > 0 ? (
          <span {...stylex.props(styles.eventDetail)}>
            {[
              statements > 0
                ? t`${plural(statements, { one: "# statement", other: "# statements" })}`
                : undefined,
              entry.detail,
            ]
              .filter(given)
              .join(" · ")}
          </span>
        ) : null}
      </div>
    </div>
  );
};

/**
 * When each fact about this note came in, oldest first, then what has not happened yet. Compact:
 * the statements a moment brought are counted here and listed on the page. A long timeline folds
 * the events before its latest by month.
 */
const Timeline = ({ note }: { note: Note }) => {
  const { t } = useLingui();
  const { earlier, recent } = splitTimeline(note.timeline);
  const folded = earlier.reduce((sum, month) => sum + month.events.length, 0);
  return (
    <div {...stylex.props(styles.timeline)}>
      {earlier.length > 0 ? (
        <div {...stylex.props(styles.earlier)}>
          <Collapsible
            fit
            title={t({
              message: plural(folded, { one: "# earlier", other: "# earlier" }),
              comment: "Earlier events on a timeline, folded away",
            })}
          >
            {earlier.map((month) => (
              <div key={month.month} {...stylex.props(styles.month)}>
                <p {...stylex.props(styles.monthName)}>
                  {formatMonth(month.month)}
                </p>
                {month.events.map((entry, index) => (
                  <TimelineEvent entry={entry} key={`${entry.date}-${index}`} />
                ))}
              </div>
            ))}
          </Collapsible>
        </div>
      ) : null}
      {recent.map((entry, index) => (
        <TimelineEvent entry={entry} key={`${entry.date}-${index}`} />
      ))}
      {note.open.map((item) => (
        <div key={item} {...stylex.props(styles.event)}>
          <span {...stylex.props(styles.day)}>
            {t({ message: "Open", context: "on a timeline: not happened yet" })}
          </span>
          <span {...stylex.props(styles.happened, styles.openEvent)}>
            {item}
          </span>
        </div>
      ))}
    </div>
  );
};

/** A folded section at the foot of the page. */
const Fold = ({
  title,
  count,
  children,
}: {
  title: string;
  /** How many it holds, beside its title; none for a fold that counts nothing. */
  count?: number;
  children: ReactNode;
}) => (
  <Collapsible
    fit
    title={
      count === undefined || count === 0 ? (
        title
      ) : (
        <>
          {title}{" "}
          <Text element="span" size="sm" tone="quiet">
            {count}
          </Text>
        </>
      )
    }
  >
    {children}
  </Collapsible>
);

/** Which of the three groups a row of the details stands in: what the note is, its work, or where it comes from and what is open. */
type DetailGroup = "about" | "work" | "context";

/** A row of the details: what it is called, and the links in it, each with why it is here where that says more than the row does. */
interface DetailRow {
  label: string;
  refs: NoteRef[];
  reasons?: Map<string, string>;
  group: DetailGroup;
}

/** Each link once, by the note or the words it names. */
const once = (refs: NoteRef[]): NoteRef[] => {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = ref.to ?? ref.label;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

/** Rows of the same label as one row, their links and reasons together. */
const mergeRows = (rows: DetailRow[]): DetailRow[] => {
  const merged: DetailRow[] = [];
  for (const row of rows) {
    const same = merged.findIndex((each) => each.label === row.label);
    const before = merged[same];
    if (before === undefined) {
      merged.push(row);
    } else {
      merged[same] = {
        ...before,
        refs: [...before.refs, ...row.refs],
        reasons: new Map([...(before.reasons ?? []), ...(row.reasons ?? [])]),
      };
    }
  }
  return merged;
};

/**
 * A note's details: its properties and its links as one list, nothing said twice, each a row of
 * its own with its names in it: first what the note is, then its work, then where it comes from
 * and what is open. What the article already shows goes: how
 * many of each kind were said; a team keeps its roles. Every tool it is
 * linked to joins the property that already names tools. The other links follow: the open
 * questions about it; its sources, its own first (for a team its interview, its employees' chats,
 * the directory) and then the conversations that name it; and any other page that names it, under
 * its kind. What names it says on hover where: the sentence of a conversation, or the property of
 * a page. Long rows are capped behind "+N".
 */
const useDetailRows = (
  note: Note,
  byId: Map<string, Note>,
  workspace: Workspace
): DetailRow[] => {
  const { t } = useLingui();
  // What the article already shows: how many of each kind were said (the tabs over the statements).
  // A team's roles stay: its banner shows its interviewees or its drawing, not the roster's roles.
  // A tool's AI, as Grasp sees it, is left out: the Landscape it belonged with was removed.
  const shown = new Set([
    t`They told us`,
    t`What was said`,
    t`AI`,
    ...(note.statementIds.length > 0
      ? [t({ message: "Added", context: "note property: what a source added" })]
      : []),
  ]);
  const kindOf = (ref: NoteRef) =>
    ref.to === undefined ? undefined : byId.get(ref.to)?.kind;
  const isTool = (ref: NoteRef): boolean =>
    kindOf(ref) === "tool" || kindOf(ref) === "app";
  const linked = note.linked.flatMap((group) => group.refs);
  const kept = note.points.filter((point) => !shown.has(point.label));
  // Every tool it is linked to joins the property that already names tools ("They use", "Tools"), where it has one.
  const withTools = kept.find((point) => point.refs.some(isTool));
  const properties: NotePoint[] = kept.map((point) =>
    point === withTools
      ? { ...point, refs: once([...point.refs, ...linked.filter(isTool)]) }
      : point
  );
  const named = new Set(
    properties.flatMap((row) =>
      row.refs.flatMap((ref) =>
        [ref.to, ref.workflowId, ref.label].filter(given)
      )
    )
  );
  const unnamed = (ref: NoteRef): boolean =>
    !(withTools && isTool(ref)) &&
    ![ref.to, ref.workflowId, ref.label].some(
      (id) => given(id) && named.has(id)
    );
  // Pages outside the brain, such as a workflow on the Workflows page, keep the group the page gives them.
  const elsewhere: NotePoint[] = note.linked
    .map((group) => ({
      label: group.title,
      refs: group.refs.filter((ref) => ref.to === undefined && unnamed(ref)),
    }))
    .filter((row) => row.refs.length > 0);
  const rest = linked.filter((ref) => ref.to !== undefined && unnamed(ref));
  const sourceOf = (ref: NoteRef): Source | undefined =>
    workspace.sources.find((source) => source.id === ref.to);
  const own = rest.filter(
    (ref) =>
      kindOf(ref) === "source" &&
      ((sourceOf(ref)?.teamIds?.includes(note.id) ?? false) ||
        note.links.includes(ref.to ?? ""))
  );
  const questions = rest.filter((ref) => kindOf(ref) === "gap");
  const namedIn = rest.filter(
    (ref) => !own.includes(ref) && !questions.includes(ref)
  );
  // A conversation that names the team is a source like its own; any other page that names it keeps its kind's group.
  const sources = [
    ...own,
    ...namedIn.filter((ref) => kindOf(ref) === "source"),
  ];
  const otherPages = note.linked
    .map((group) => ({
      label: group.title,
      refs: group.refs.filter(
        (ref) => namedIn.includes(ref) && kindOf(ref) !== "source"
      ),
    }))
    .filter((row) => row.refs.length > 0);
  const { title } = note;
  // Where a note names this team: the first sentence of a conversation about it, or the properties of a page that list it.
  const reasons = new Map(
    namedIn.flatMap((ref): [string, string][] => {
      const source = sourceOf(ref);
      if (source) {
        const said = workspace.statements.filter(
          (statement) =>
            statement.sourceId === source.id &&
            note.statementIds.includes(statement.id)
        );
        const [first] = said;
        const more = said.length - 1;
        if (first) {
          return [
            [
              ref.to ?? "",
              more > 0
                ? `${statementWords(first.id, first.text)} ${t`and ${more} more`}`
                : statementWords(first.id, first.text),
            ],
          ];
        }
      }
      const where = (byId.get(ref.to ?? "")?.points ?? [])
        .filter((point) => point.refs.some((each) => each.to === note.id))
        .map((point) => `“${point.label}”`);
      const under = where.join(", ");
      return where.length > 0
        ? [[ref.to ?? "", t`Names ${title} under ${under}`]]
        : [];
    })
  );
  // A row about workflows is the note's work; what it is stays on top; where it comes from and what is open close the list.
  const isWork = (row: { refs: NoteRef[] }): boolean =>
    row.refs.some(
      (ref) =>
        (given(ref.workflowId) && ref.to === undefined) ||
        kindOf(ref) === "candidate"
    );
  // A row of another page's kind that the properties already have, such as Workflows, joins that row.
  const rows = mergeRows(
    [
      ...properties.map((row): DetailRow => ({
        ...row,
        group: isWork(row) ? "work" : "about",
      })),
      ...elsewhere.map((row): DetailRow => ({ ...row, group: "work" })),
      { label: t`Open questions`, refs: questions, group: "context" as const },
      { label: t`Sources`, refs: sources, reasons, group: "context" as const },
      ...otherPages.map((row): DetailRow => ({
        ...row,
        reasons,
        group: isWork(row) ? "work" : "context",
      })),
    ].filter((row) => row.refs.length > 0)
  );
  // What the note is first, then its work, then where it comes from and what is open.
  const order: DetailGroup[] = ["about", "work", "context"];
  return order.flatMap((group) => rows.filter((row) => row.group === group));
};

/** A row's names: a chip for each note, with why it is here where that says more; plain words for the rest. */
const RowNames = ({
  row,
  byId,
}: {
  row: DetailRow;
  byId: Map<string, Note>;
}) => (
  <Capped>
    {row.refs.map((ref, at) => {
      const target = ref.to === undefined ? undefined : byId.get(ref.to);
      return target ? (
        <NoteChip
          key={`${ref.to}-${at}`}
          label={ref.label}
          note={target}
          reason={row.reasons?.get(target.id)}
        />
      ) : (
        <Ref byId={byId} key={`${ref.label}-${at}`} value={ref} />
      );
    })}
  </Capped>
);

/**
 * A team's or a subject's details, at the side of its article: each row under its own heading
 * with its names below it, the whole width of the side.
 */
const DetailRows = ({
  note,
  byId,
  workspace,
}: {
  note: Note;
  byId: Map<string, Note>;
  workspace: Workspace;
}) => (
  <div {...stylex.props(styles.details)}>
    {useDetailRows(note, byId, workspace).map((row) => (
      <section key={row.label} {...stylex.props(styles.detail)}>
        <Heading level={3} size="ui-sm">
          {row.label}
        </Heading>
        <RowNames byId={byId} row={row} />
      </section>
    ))}
  </div>
);

/** A row's icon: the note's work, where it comes from, or what it links to. */
const rowIcon = (row: DetailRow, sourcesLabel: string): IconData => {
  if (row.group === "work") {
    return Workflow;
  }
  return row.label === sourcesLabel ? Folder : LinkIcon;
};

/**
 * The note's facts, behind the page's Properties: what it is, when it was last heard, then its
 * details. Questions it waits on stand as questions of their own, so their row goes when there
 * are any.
 */
const useNoteFacts = ({
  note,
  byId,
  workspace,
  lastHeard,
  asking,
}: {
  note: Note;
  byId: Map<string, Note>;
  workspace: Workspace;
  lastHeard: string | undefined;
  asking: boolean;
}): PageFact[] => {
  const { t, i18n } = useLingui();
  const questionsLabel = t`Open questions`;
  const sourcesLabel = t`Sources`;
  const rows = useDetailRows(note, byId, workspace).filter(
    (row) => !(asking && row.label === questionsLabel)
  );
  return [
    { key: t`Kind`, value: i18n._(kindLabel[note.kind]), icon: NoteIcon },
    ...(lastHeard === undefined
      ? []
      : [{ key: t`Last heard`, value: formatDay(lastHeard), icon: Clock }]),
    ...rows.map((row) => ({
      key: row.label,
      icon: rowIcon(row, sourcesLabel),
      value: <RowNames byId={byId} row={row} />,
    })),
  ];
};

/** The questions the brain still waits on about this note, each with the role that can answer. */
const openQuestionsOf = (
  note: Note,
  workspace: Workspace
): PageOpenQuestion[] =>
  workspace.gaps
    .filter(
      (gap) =>
        gap.about.includes(note.id) &&
        gap.closedAt === undefined &&
        gap.answer === undefined
    )
    .map((gap) => ({ id: gap.id, question: gap.question, who: gap.owner }));

/** Exports the note, as Markdown or a PDF, with its full history and, for a conversation, its transcript. */
const ExportButton = ({
  note,
  source,
}: {
  note: Note;
  source: Source | undefined;
}) => (
  <ExportMenu
    file={{
      name: noteFileName(note),
      title: note.title,
      markdown: () =>
        noteMarkdown(note, {
          baseUrl: window.location.origin,
          exportedOn: new Date().toISOString().slice(0, 10),
          ...(source?.transcript === undefined
            ? {}
            : { transcript: source.transcript }),
        }),
    }}
  />
);

/** A team's or a subject's article: back, its kind, and its actions. */
const NoteToolbar = ({ note }: { note: Note }) => {
  const { t } = useLingui();
  return (
    // The row wraps when there is no room for both sides, so nothing runs off the page.
    <div {...stylex.props(styles.toolbar)}>
      <div {...stylex.props(styles.toolbarSide)}>
        <BackButton />
        <KindTag kind={note.kind} />
      </div>
      <div {...stylex.props(styles.toolbarSide)}>
        {/* Back to where this note sits in the brain. */}
        <Button
          icon={BrainMark}
          render={<Link search={{ note: note.id }} to="/brain" />}
          size="sm"
        >
          {t`Show in the brain`}
        </Button>
        <ExportButton note={note} source={undefined} />
      </div>
    </div>
  );
};

/** What a tool is, on its banner: its logo. None for any other note, whose banner then shows its part's drawing. */
const stickerOf = (note: Note): ReactNode =>
  note.kind === "tool" || note.kind === "app" ? (
    <AppLogo name={note.title} size="lg" />
  ) : undefined;

/** The statements that name the note without being linked to it, folded at the page's foot. */
const Mentions = ({ note }: { note: Note }) => {
  const { t } = useLingui();
  if (note.mentions.length === 0) {
    return null;
  }
  return (
    <Fold count={note.mentions.length} title={t`Named, not linked`}>
      <MentionLinks mentions={note.mentions} />
    </Fold>
  );
};

/**
 * What a source holds beyond Grasp's text: a document as a page, a conversation word for word,
 * or what an import brought in and what was said in it, one kind at a time. None for a note with
 * nothing more.
 */
const SourceBody = ({
  note,
  workspace,
  byId,
  transcribed,
  statements,
  activeId,
  onRemove,
}: NoteParts) => {
  if (transcribed?.transcript.unit === "passage") {
    // A document is read as a page: its own text, with what was tagged in it highlighted.
    return (
      <DocumentView
        activeId={activeId}
        source={transcribed}
        statements={workspace.statements}
      />
    );
  }
  if (transcribed) {
    return (
      <TranscriptView
        activeId={activeId}
        onRemove={onRemove}
        source={transcribed}
        statements={workspace.statements}
      />
    );
  }
  // An import has no text of its own: what it brought in is its content.
  const contents = workspace.sources.some((source) => source.id === note.id)
    ? sourceContents(workspace, note.id)
    : undefined;
  if (contents === undefined && statements.length === 0) {
    return null;
  }
  return (
    <>
      {contents ? (
        <SourceContentsTable byId={byId} contents={contents} />
      ) : null}
      {statements.length > 0 ? (
        <StatementsByKind
          activeId={activeId}
          kern={kernOf(note.id, statements)}
          onRemove={onRemove}
          rows={statements}
        />
      ) : null}
    </>
  );
};

/** What both kinds of note page are given: the note, what it was told, and how to take a statement out. */
interface NoteParts {
  note: Note;
  workspace: Workspace;
  byId: Map<string, Note>;
  transcribed: TranscribedSource | undefined;
  statements: StatementRow[];
  /** The statement a link opened, when it is one of this note's. */
  activeId: string | undefined;
  /** Takes one thing that was said out of the brain, for whoever may. */
  onRemove: ((statement: Statement) => void) | undefined;
}

/**
 * A note as a Brain page (the library's page-brain, Ruben's pick D): its title, its facts and open
 * questions behind Properties, Grasp's text, then what else a source holds, and its timeline and
 * the statements that name it folded at its foot. The company's page, the brain's home, is its
 * text alone.
 */
const BrainPageNote = (parts: NoteParts) => {
  const { t } = useLingui();
  const { brain } = useBrainData();
  const { note, workspace, byId, statements } = parts;
  const company = note.kind === "company";
  const companyText = useCompanyText(brain);
  const questions = openQuestionsOf(note, workspace);
  const facts = useNoteFacts({
    note,
    byId,
    workspace,
    // A source's summary already carries its date; the company is heard from everywhere.
    lastHeard:
      note.kind === "source" || company
        ? undefined
        : kernOf(note.id, statements).lastHeard,
    asking: questions.length > 0,
  });
  const events = note.timeline.length;
  return (
    <div {...stylex.props(styles.page)}>
      <NoteBrainPage
        byId={byId}
        facts={facts}
        note={note}
        questions={questions}
        {...(company ? { text: companyText } : {})}
      />
      {company ? null : (
        <div {...stylex.props(styles.rest)}>
          <SourceBody {...parts} />
          {events > 0 || note.open.length > 0 ? (
            <Fold count={events} title={t`Timeline`}>
              <Timeline note={note} />
            </Fold>
          ) : null}
          <Mentions note={note} />
        </div>
      )}
    </div>
  );
};

/**
 * A team's or a subject's page, as it was before page D, until Ruben picks between D and the
 * library's parked BrainSubject for them: the banner of its part, the title and summary, its
 * write-up, a team's work or what was said, one kind at a time; at the side its details and its
 * timeline.
 */
const ArticleNote = ({
  note,
  workspace,
  byId,
  statements,
  activeId,
  onRemove,
}: NoteParts) => {
  const { t } = useLingui();
  const { brain } = useBrainData();
  const events = note.timeline.length;
  // A page with no properties or links of its own lists what it holds on its timeline.
  const details = note.points.length > 0 || note.linked.length > 0;
  const timeline = events > 0 || note.open.length > 0;
  const tabs: SideTab[] = [
    ...(details
      ? [
          {
            value: "details",
            label: t`Details`,
            content: (
              <DetailRows byId={byId} note={note} workspace={workspace} />
            ),
          },
        ]
      : []),
    ...(timeline
      ? [
          {
            value: "timeline",
            label: t`Timeline`,
            // A timeline of only what is still open counts nothing that happened.
            ...(events > 0 ? { count: events } : {}),
            content: <Timeline note={note} />,
          },
        ]
      : []),
  ];
  return (
    <NoteArticle
      footer={note.mentions.length > 0 ? <Mentions note={note} /> : undefined}
      header={
        <BannerHeader
          kern={kernOf(note.id, statements)}
          note={note}
          sticker={stickerOf(note)}
        />
      }
      tabs={tabs}
      toolbar={<NoteToolbar note={note} />}
    >
      <Article
        byId={byId}
        nameable={nameableFrom(note, byId)}
        paragraphs={note.article}
      />
      {note.kind === "team" ? (
        // A team's page is its work, never its people's words: those live on the work's pages.
        <TeamWork brain={brain} team={note} ws={workspace} />
      ) : null}
      {note.kind !== "team" && statements.length > 0 ? (
        <StatementsByKind
          activeId={activeId}
          kern={kernOf(note.id, statements)}
          onRemove={onRemove}
          rows={statements}
        />
      ) : null}
    </NoteArticle>
  );
};

/**
 * One note's page: what it was told and who may take a statement out, then a team's or a
 * subject's article, or the Brain page every other note has.
 */
const NoteContent = ({
  note,
  workspace,
  byId,
  hash,
}: {
  note: Note;
  workspace: Workspace;
  byId: Map<string, Note>;
  hash: string;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const canForget = useCanForget();
  // Once a source is gone its page is too: back to the brain. One thing said goes and the page stays.
  const forget = useForget((target) => {
    if ("source" in target) {
      void navigate({ to: "/brain" });
    }
  });
  const source = workspace.sources.find(
    (candidate) => candidate.id === note.id
  );
  const onRemove = canForget
    ? (statement: Statement) => {
        forget.ask({ statements: [statement.id] }, t`what was said`);
      }
    : undefined;
  const transcribed: TranscribedSource | undefined =
    source?.transcript === undefined
      ? undefined
      : { ...source, transcript: source.transcript };
  const statements = note.statementIds.flatMap((id) => {
    const statement = workspace.statements.find(
      (candidate) => candidate.id === id
    );
    const place = statement ? placeOf(statement, workspace.sources) : undefined;
    return statement && place
      ? [{ statement, place, who: labelOf(workspace, place.source) }]
      : [];
  });
  const parts: NoteParts = {
    note,
    workspace,
    byId,
    transcribed,
    statements,
    activeId: statements.some((row) => row.statement.id === hash)
      ? hash
      : undefined,
    onRemove,
  };
  return (
    <>
      {onArticle(note) ? (
        <ArticleNote {...parts} />
      ) : (
        <BrainPageNote {...parts} />
      )}
      {forget.element}
    </>
  );
};

/**
 * A piece of work's page: its note, and what Grasp knows about it in its
 * own sentences (`?knowledge` opens that tab, as the brain's navigation
 * does).
 */
const WorkTabs = ({ note, children }: { note: Note; children: ReactNode }) => {
  const { t } = useLingui();
  const { knowledge } = Route.useSearch();
  const navigate = useNavigate({ from: "/brain/$noteId" });
  return (
    <Tabs
      onValueChange={(value) => {
        void navigate({
          search: value === "knowledge" ? { knowledge: true } : {},
          hash: (previous) => previous ?? "",
        });
      }}
      value={knowledge === true ? "knowledge" : "note"}
    >
      <div {...stylex.props(styles.workTabs)}>
        <TabsList>
          <TabsTrigger value="note">
            {t({
              message: "Note",
              context: "tab: a piece of work's note in the brain",
            })}
          </TabsTrigger>
          <TabsTrigger value="knowledge">
            {t({
              message: "Knowledge",
              context: "tab: what Grasp knows about a piece of work",
            })}
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="note">{children}</TabsContent>
      <TabsContent value="knowledge">
        <div {...stylex.props(styles.knowledge)}>
          <WorkKnowledgeTab work={note.id} />
        </div>
      </TabsContent>
    </Tabs>
  );
};

/**
 * One note, read like a page, the same for every kind (`brain/brain-article/`): the banner of
 * its part with who or what it is, the title and summary, its own text or its conversation, and
 * what was said, one kind at a time. At the side its details (properties and links as one list,
 * nothing said twice) and its timeline, and beside a transcript its topics and statements. The
 * company's note is the exception: it is the brain's home. Everything in it starts afresh for
 * another note.
 */
const NotePage = () => {
  const { t } = useLingui();
  const { noteId } = Route.useParams();
  const { brain, workspace: read } = useBrainData();
  const { transcript } = Route.useLoaderData();
  const workspace = withTranscript(read, noteId, transcript);
  // The statement a link opened: its id is the address's hash.
  const hash = useLocation({ select: (location) => location.hash });
  const note = brain.notes.find((candidate) => candidate.id === noteId);

  if (!note) {
    return <NotFoundState icon={BrainMark} title={t`Note not found`} />;
  }
  const content = (
    <>
      {transcript === undefined ? null : <NotLoaded page={transcript} />}
      <NoteContent
        byId={
          new Map(brain.notes.map((candidate) => [candidate.id, candidate]))
        }
        hash={hash}
        key={note.id}
        note={note}
        workspace={workspace}
      />
    </>
  );
  // A piece of work has what Grasp knows about it beside its note.
  return note.kind === "candidate" ? (
    <WorkTabs note={note}>{content}</WorkTabs>
  ) : (
    content
  );
};

export const Route = createFileRoute("/_shell/brain/$noteId")({
  // `?knowledge` opens a piece of work on what Grasp knows about it.
  validateSearch: (search: Record<string, unknown>): { knowledge?: true } =>
    search.knowledge === true || search.knowledge === "true"
      ? { knowledge: true }
      : {},
  // The note's transcript, when its source has one: `brain.read`, which the
  // layout read, says only how many turns it has.
  loader: async ({
    abortController,
    context: { core },
    params: { noteId },
    parentMatchPromise,
  }) => {
    const { loaderData } = await parentMatchPromise;
    const workspace =
      loaderData?.state === "ready" ? loaderData.data.workspace : undefined;
    return {
      transcript: await loadTranscript(
        core,
        workspace,
        noteId,
        abortController.signal
      ),
    };
  },
  // Going to a note whose transcript is read: its banner and text wait,
  // under the layout's bar.
  pendingComponent: NotePending,
  component: NotePage,
});
