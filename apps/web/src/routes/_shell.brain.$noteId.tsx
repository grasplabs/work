import type { Source, Workspace } from "@grasp-os/shared/brain";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, useLocation } from "@tanstack/react-router";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { intervieweeOf, kernOf } from "../brain/article-kern.ts";
import type { StatementRow } from "../brain/article-kern.ts";
import { BackButton } from "../brain/back-button.tsx";
import { BannerHeader, Interviewed } from "../brain/brain-article/kern.tsx";
import { NoteArticle } from "../brain/brain-article/note-article.tsx";
import type { SideTab } from "../brain/brain-article/note-article.tsx";
import { StatementsByKind } from "../brain/brain-article/statements-by-kind.tsx";
import { Capped, NoteChip } from "../brain/brain-chips.tsx";
import { dotClass, tintClass } from "../brain/brain-colors.ts";
import { useBrainData } from "../brain/brain-data.ts";
import { HomePage } from "../brain/brain-home.tsx";
import { noteFileName, noteMarkdown } from "../brain/brain-markdown.ts";
import { SourceContentsTable } from "../brain/brain-source-contents.tsx";
import {
  DocumentView,
  TranscriptRail,
  TranscriptView,
} from "../brain/brain-transcript.tsx";
import type { TranscribedSource } from "../brain/brain-transcript.tsx";
import {
  given,
  kindLabel,
  mentionParts,
  quoted,
  sourceContents,
  splitTimeline,
} from "../brain/brain.ts";
import type { Note, NoteEvent, NotePoint, NoteRef } from "../brain/brain.ts";
import { placeOf } from "../brain/transcript.ts";
import { AppLogo } from "../connections/app-logo.tsx";
import { ExportMenu } from "../export/export-menu.tsx";
import { formatDay, formatMonth } from "../format.ts";
import { NotFoundState } from "../frame/page-states.tsx";

// One note, as the prototype has it (`routes/brain/$noteId.tsx`). Where the
// prototype links out of the brain, to a workflow on its Workflows page, a
// policy or a domain, Grasp OS has no such page yet: those names stay
// plain words, and a note's domains are left out, as core gives the brain
// none (brain-rpc.ts).

/** A name in a property: a chip for a note, or plain words. */
const Ref = ({ value, byId }: { value: NoteRef; byId: Map<string, Note> }) => {
  const target = value.to === undefined ? undefined : byId.get(value.to);
  if (target) {
    return <NoteChip label={value.label} note={target} />;
  }
  return <span className="min-w-0 py-0.5 wrap-break-word">{value.label}</span>;
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
    <section className="flex flex-col gap-3 border-t pt-6 text-sm leading-7">
      {paragraphs.map((paragraph) => (
        <p key={paragraph}>
          <Mentioned byId={byId} nameable={nameable} text={paragraph} />
        </p>
      ))}
    </section>
  );
};

/**
 * A conversation's page: its summary, and the whole conversation word for word with its statements
 * highlighted. It opens on the transcript, and a link to a statement always brings it there.
 */
const SourceTabs = ({
  source,
  statements,
  activeId,
  children,
}: {
  source: TranscribedSource;
  statements: Workspace["statements"];
  activeId: string | undefined;
  children: ReactNode;
}) => {
  const [tab, setTab] = useState("transcript");
  const [opened, setOpened] = useState(activeId);
  // The transcript's search and filter sit in the tab row, beside the tabs.
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  // A link to another statement opens the transcript again, even after the reader went to the summary.
  if (activeId !== opened) {
    setOpened(activeId);
    if (activeId !== undefined) {
      setTab("transcript");
    }
  }
  return (
    <div className="border-t pt-4">
      <Tabs
        onValueChange={(value: string) => {
          setTab(value);
        }}
        value={tab}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <TabsList variant="line">
            <TabsTrigger value="summary">
              <Trans context="tab: an interview written up short">
                Summary
              </Trans>
            </TabsTrigger>
            <TabsTrigger value="transcript">
              <Trans context="tab: the whole conversation word for word">
                Transcript
              </Trans>
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto" ref={setToolbar} />
        </div>
        <TabsContent value="summary">{children}</TabsContent>
        <TabsContent value="transcript">
          {/* The transcript stays mounted behind the summary, so its tools only take the row while it shows. */}
          <TranscriptView
            activeId={activeId}
            source={source}
            statements={statements}
            toolbarIn={tab === "transcript" ? toolbar : null}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
};

const EventTitle = ({ entry }: { entry: NoteEvent }) => {
  if (entry.to !== undefined) {
    return (
      <Link
        className="leading-snug hover:underline"
        params={{ noteId: entry.to }}
        to="/brain/$noteId"
      >
        {entry.title}
      </Link>
    );
  }
  return <span className="leading-snug">{entry.title}</span>;
};

const TimelineEvent = ({ entry }: { entry: NoteEvent }) => {
  const { t } = useLingui();
  const own = entry.own || entry.quotes.some((quote) => quote.own);
  const statements = entry.quotes.length;
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3">
      <span className="text-muted-foreground text-xs leading-5">
        {formatDay(entry.date)}
      </span>
      <div
        className={`flex flex-col gap-0.5 border-l-2 pb-3 pl-3 ${own ? "border-foreground" : "border-border"}`}
      >
        <EventTitle entry={entry} />
        {given(entry.detail) || statements > 0 ? (
          <span className="text-muted-foreground text-xs">
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
  const { earlier, recent } = splitTimeline(note.timeline);
  const folded = earlier.reduce((sum, month) => sum + month.events.length, 0);
  return (
    <div className="flex flex-col text-sm">
      {earlier.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger
            render={<Button className="mb-2 -ml-2" size="xs" variant="ghost" />}
          >
            <ChevronRightIcon className="transition-transform group-aria-expanded/button:rotate-90" />
            <Plural
              comment="Earlier events on a timeline, folded away"
              one="# earlier"
              other="# earlier"
              value={folded}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            {earlier.map((month) => (
              <div className="flex flex-col" key={month.month}>
                <p className="text-muted-foreground pb-2 text-xs">
                  {formatMonth(month.month)}
                </p>
                {month.events.map((entry, index) => (
                  <TimelineEvent entry={entry} key={`${entry.date}-${index}`} />
                ))}
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {recent.map((entry, index) => (
        <TimelineEvent entry={entry} key={`${entry.date}-${index}`} />
      ))}
      {note.open.map((item) => (
        <div
          className="text-muted-foreground grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3"
          key={item}
        >
          <span className="text-xs leading-5">
            <Trans context="on a timeline: not happened yet">Open</Trans>
          </span>
          <span className="border-l-2 border-dashed pb-3 pl-3">{item}</span>
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
  count: number;
  children: ReactNode;
}) => (
  <Collapsible>
    <CollapsibleTrigger
      render={<Button className="-ml-2.5" size="sm" variant="ghost" />}
    >
      <ChevronRightIcon className="text-muted-foreground transition-transform group-aria-expanded/button:rotate-90" />
      {title}
      <span className="text-muted-foreground">{count}</span>
    </CollapsibleTrigger>
    <CollapsibleContent>{children}</CollapsibleContent>
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
 * A note's details: its properties and its links as one list, nothing said twice, each under its
 * own heading with its names below it, the whole width of the side: first what the note is, then
 * its work, then where it comes from and what is open. What the article already shows goes: how
 * many of each kind were said, and a team's roles, which stand on its banner. Every tool it is
 * linked to joins the property that already names tools. The other links follow: the open
 * questions about it; its sources, its own first (for a team its interview, its employees' chats,
 * the directory) and then the conversations that name it; and any other page that names it, under
 * its kind. What names it says on hover where: the sentence of a conversation, or the property of
 * a page. Long rows are capped behind "+N".
 */
const DetailRows = ({
  note,
  byId,
  workspace,
}: {
  note: Note;
  byId: Map<string, Note>;
  workspace: Workspace;
}) => {
  const { t } = useLingui();
  // What the article already shows: how many of each kind were said (the tabs over the statements), and a team's roles (its banner).
  // A tool's AI, as Grasp sees it, belongs with the Landscape, which is parked: it is left out for now.
  const shown = new Set([
    t`Roles`,
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
                ? `${quoted(first.text)} ${t`and ${more} more`}`
                : quoted(first.text),
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
  const sorted = order.flatMap((group) =>
    rows.filter((row) => row.group === group)
  );
  return (
    <div className="flex flex-col divide-y text-sm">
      {sorted.map((row) => (
        <section
          className="flex flex-col gap-1.5 py-3.5 first:pt-0"
          key={row.label}
        >
          <h3 className="font-medium">{row.label}</h3>
          <Capped>
            {row.refs.map((ref, at) => {
              const target =
                ref.to === undefined ? undefined : byId.get(ref.to);
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
        </section>
      ))}
    </div>
  );
};

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

/** Back, the kind, and the page's actions. */
const NoteToolbar = ({
  note,
  source,
}: {
  note: Note;
  source: Source | undefined;
}) => {
  const { i18n } = useLingui();
  return (
    // The row wraps when there is no room for both sides, so nothing runs off the page.
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex items-center gap-2">
        <BackButton />
        <span
          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ${tintClass(note.kind)}`}
        >
          <span className={`size-1.5 rounded-full ${dotClass(note.kind)}`} />
          {i18n._(kindLabel[note.kind])}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        {/* Back to the brain. In the prototype it opens the atlas where this note sits; the atlas
            comes in a later change. */}
        <Button
          nativeButton={false}
          render={<Link to="/brain" />}
          size="sm"
          variant="outline"
        >
          <BrainIcon />
          <Trans>Show in the brain</Trans>
        </Button>
        <ExportButton note={note} source={source} />
      </div>
    </div>
  );
};

/**
 * Who or what the note is, on its banner: a tool's logo, or the person a conversation was with.
 * None for any other note, whose banner then shows its interviewees or its part's drawing.
 */
const stickerOf = (note: Note, source: Source | undefined): ReactNode => {
  if (note.kind === "tool" || note.kind === "app") {
    return <AppLogo name={note.title} size="lg" />;
  }
  return source?.interviewee === undefined ? undefined : (
    <Interviewed people={[intervieweeOf(source)]} />
  );
};

/**
 * The notes the article may name, as chips: everything around this note and in its properties,
 * but the statements and sources, which have their own places. The company is always nameable:
 * the longest name wins, so "Noordkade Finance" never reads as the Finance team.
 */
const nameableFrom = (note: Note, byId: Map<string, Note>): Note[] =>
  [
    ...new Set([
      "company",
      ...note.links,
      ...note.backlinks,
      ...note.points.flatMap((point) =>
        point.refs.flatMap((ref) => (ref.to === undefined ? [] : [ref.to]))
      ),
    ]),
  ]
    .map((id) => byId.get(id))
    .filter(
      (candidate): candidate is Note =>
        candidate !== undefined &&
        candidate.kind !== "statement" &&
        candidate.kind !== "source"
    );

/** The statements that name the note without being linked to it, folded at the page's foot. */
const Mentions = ({ note }: { note: Note }) => {
  const { t } = useLingui();
  if (note.mentions.length === 0) {
    return null;
  }
  return (
    <Fold count={note.mentions.length} title={t`Named, not linked`}>
      <div className="flex flex-col gap-1 pt-2 pb-4">
        {note.mentions.map((mention) => (
          <Link
            className="text-muted-foreground hover:text-foreground text-sm leading-snug"
            hash={mention.statementId}
            key={mention.statementId}
            params={{ noteId: mention.sourceId }}
            to="/brain/$noteId"
          >
            {quoted(mention.text)}
          </Link>
        ))}
      </div>
    </Fold>
  );
};

/** What the note says: a source's own words, or its article and what was said, one kind at a time. */
const NoteBody = ({
  note,
  workspace,
  byId,
  transcribed,
  statements,
  activeId,
}: {
  note: Note;
  workspace: Workspace;
  byId: Map<string, Note>;
  transcribed: TranscribedSource | undefined;
  statements: StatementRow[];
  activeId: string | undefined;
}) => {
  const nameable = nameableFrom(note, byId);
  const article = (
    <Article byId={byId} nameable={nameable} paragraphs={note.article} />
  );
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
  if (transcribed && note.article === undefined) {
    // A short conversation without a write-up, such as an employee's chat interview: only its words.
    return (
      <TranscriptView
        activeId={activeId}
        source={transcribed}
        statements={workspace.statements}
      />
    );
  }
  if (transcribed) {
    return (
      <SourceTabs
        activeId={activeId}
        source={transcribed}
        statements={workspace.statements}
      >
        {article}
      </SourceTabs>
    );
  }
  // An import has no text of its own: what it brought in is its content.
  const source = workspace.sources.find(
    (candidate) => candidate.id === note.id
  );
  const contents =
    source === undefined ? undefined : sourceContents(workspace, source.id);
  return (
    <>
      {contents ? (
        <SourceContentsTable byId={byId} contents={contents} />
      ) : null}
      {article}
      {statements.length > 0 ? (
        <StatementsByKind
          kern={kernOf(note.id, statements)}
          rows={statements}
        />
      ) : null}
    </>
  );
};

/** One note's page, but the company's: its article, and its details and timeline at the side. */
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
  const source = workspace.sources.find(
    (candidate) => candidate.id === note.id
  );
  const transcribed: TranscribedSource | undefined =
    source?.transcript === undefined
      ? undefined
      : { ...source, transcript: source.transcript };
  const statements = note.statementIds.flatMap((id) => {
    const statement = workspace.statements.find(
      (candidate) => candidate.id === id
    );
    const place = statement ? placeOf(statement, workspace.sources) : undefined;
    return statement && place ? [{ statement, place }] : [];
  });
  // The statement a link opened, when it is one of this note's.
  const activeId = statements.some((row) => row.statement.id === hash)
    ? hash
    : undefined;
  const kern = kernOf(note.id, statements);
  const events = note.timeline.length;
  // A page such as a source folder's has no properties or links of its own: its timeline lists what it holds.
  const details = note.points.length > 0 || note.linked.length > 0;
  const timeline = events > 0 || note.open.length > 0;
  const tabs: SideTab[] = [
    ...(transcribed === undefined || transcribed.transcript.unit === "passage"
      ? []
      : [
          {
            value: "conversation",
            label: t`In this conversation`,
            content: (
              <TranscriptRail
                activeId={activeId}
                source={transcribed}
                statements={workspace.statements}
              />
            ),
          },
        ]),
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
            count: events,
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
          kern={kern}
          note={note}
          sticker={stickerOf(note, source)}
        />
      }
      tabs={tabs}
      toolbar={<NoteToolbar note={note} source={source} />}
    >
      <NoteBody
        activeId={activeId}
        byId={byId}
        note={note}
        statements={statements}
        transcribed={transcribed}
        workspace={workspace}
      />
    </NoteArticle>
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
  const { brain, workspace } = useBrainData();
  // The statement a link opened: its id is the address's hash.
  const hash = useLocation({ select: (location) => location.hash });
  const note = brain.notes.find((candidate) => candidate.id === noteId);

  if (!note) {
    return <NotFoundState icon={BrainIcon} title={t`Note not found`} />;
  }
  // The company note is the brain's home, a page to go on from, without a timeline beside it.
  if (note.kind === "company") {
    const source = workspace.sources.find(
      (candidate) => candidate.id === note.id
    );
    return (
      <HomePage
        brain={brain}
        toolbar={<NoteToolbar note={note} source={source} />}
      />
    );
  }
  return (
    <NoteContent
      byId={new Map(brain.notes.map((candidate) => [candidate.id, candidate]))}
      hash={hash}
      key={note.id}
      note={note}
      workspace={workspace}
    />
  );
};

export const Route = createFileRoute("/_shell/brain/$noteId")({
  component: NotePage,
});
