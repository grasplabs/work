import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { formatDay } from "../../format.ts";
import type { Interviewee, Kern, StatementRow } from "../article-kern.ts";
import { Drawing, Panel } from "../brain-home.tsx";
import { given, groupOf, quoted } from "../brain.ts";
import type { Note } from "../brain.ts";
import { KindLabel } from "../statement-kind.tsx";

// The pieces of a note's article, as the prototype has them
// (`components/brain-article/kern.tsx`).

/** When the team was last heard: the date of the newest conversation, so the reader knows how fresh it is. */
export const LastHeard = ({ date }: { date: string }) => {
  const day = formatDay(date);
  return (
    <span className="text-status-agreed inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
      <span className="bg-status-agreed size-1.5 rounded-full" />
      <Trans>Last heard {day}</Trans>
    </span>
  );
};

/**
 * Everyone the team was heard through in an interview, as initials on the banner. Pointing at one
 * says who it is as the source names them (Grasp keeps no names), their role, and how and when they
 * were interviewed; a click opens the interview.
 */
export const Interviewed = ({ people }: { people: Interviewee[] }) => {
  const { t } = useLingui();
  return (
    <div className="flex -space-x-2">
      {people.map((person) => {
        const day = formatDay(person.date);
        const who = person.label;
        return (
          <Tooltip key={person.sourceId}>
            <TooltipTrigger
              render={
                <Link
                  aria-label={t`${who}, interviewed ${day}`}
                  className="border-graph-teams bg-background text-graph-teams focus-visible:ring-ring/50 flex size-10 items-center justify-center rounded-full border-2 text-xs font-medium transition-transform outline-none hover:z-10 hover:-translate-y-0.5 focus-visible:z-10 focus-visible:ring-3"
                  params={{ noteId: person.sourceId }}
                  to="/brain/$noteId"
                />
              }
            >
              {person.initials}
            </TooltipTrigger>
            <TooltipContent>
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{person.label}</span>
                {person.label === person.role ? null : (
                  <span>{person.role}</span>
                )}
                <span className="opacity-70">
                  {[
                    person.stakeholder ? t`Stakeholder` : t`Employee`,
                    person.how,
                    day,
                  ]
                    .filter(given)
                    .join(" · ")}
                </span>
              </span>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
};

/**
 * The top of a note's page: the banner of the part it belongs to, as the part's own page shows it,
 * then the title and the summary with when the note was last heard of. On the banner sits who or
 * what the note is: a team's people interviewed, a tool's logo, a conversation's speaker, handed in
 * as `sticker`; a note with none shows the part's drawing.
 */
export const BannerHeader = ({
  note,
  kern,
  sticker,
}: {
  note: Note;
  kern: Kern;
  sticker?: ReactNode;
}) => {
  const group = groupOf[note.kind];
  const shown =
    sticker ??
    (kern.interviewed.length > 0 ? (
      <Interviewed people={kern.interviewed} />
    ) : undefined);
  return (
    <header className="flex flex-col gap-4">
      <Panel group={group} short>
        {shown === undefined ? (
          <Drawing group={group} small />
        ) : (
          <div className="absolute bottom-4 left-5">{shown}</div>
        )}
      </Panel>
      <span className="flex flex-col gap-0.5">
        <h1 className="text-2xl font-medium tracking-tight wrap-break-word">
          {note.kind === "statement" ? quoted(note.title) : note.title}
        </h1>
        {/* Last heard follows the summary's last word, so a summary that wraps keeps it beside its words. A source's summary already carries its date. */}
        <p className="text-muted-foreground text-sm">
          {note.summary}
          {note.kind === "source" || kern.lastHeard === undefined ? null : (
            <>
              {" "}
              <span className="ml-1.5">
                <LastHeard date={kern.lastHeard} />
              </span>
            </>
          )}
        </p>
      </span>
    </header>
  );
};

/** A statement as a line in a list: its words, and where and when it was said; both open it where it was said. */
export const StatementLine = ({
  row,
  showKind = false,
}: {
  row: StatementRow;
  showKind?: boolean;
}) => {
  const { statement, place } = row;
  return (
    <li
      className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-4 border-t py-2.5 text-sm first:border-t-0"
      data-statement={statement.id}
    >
      <span className="flex min-w-0 flex-col gap-1">
        <Link
          className="hover:underline"
          hash={statement.id}
          params={{ noteId: place.source.id }}
          to="/brain/$noteId"
        >
          {statement.text}
        </Link>
        {showKind ? (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <KindLabel kind={statement.kind} />
          </span>
        ) : null}
      </span>
      <Link
        className="text-muted-foreground hover:text-foreground max-w-64 truncate text-right text-xs hover:underline"
        hash={statement.id}
        params={{ noteId: place.source.id }}
        title={place.source.title}
        to="/brain/$noteId"
      >
        {[place.source.who, place.at ?? formatDay(place.source.date)]
          .filter(given)
          .join(" · ")}
      </Link>
    </li>
  );
};

/** A heading over a part of the article, with how many it holds. */
export const PartHeading = ({
  title,
  count,
  children,
}: {
  title: string;
  count?: number | string;
  children?: ReactNode;
}) => (
  <div className="flex flex-wrap items-center justify-between gap-3">
    <h2 className="flex items-baseline gap-2 text-sm font-medium">
      {title}
      {count === undefined ? null : (
        <span className="text-muted-foreground font-normal">{count}</span>
      )}
    </h2>
    {children}
  </div>
);

/** A folded part of the article, as the page folds its links: closed until asked for. */
export const Fold = ({
  title,
  count,
  children,
}: {
  title: string;
  count?: number | undefined;
  children: ReactNode;
}) => (
  <Collapsible>
    <CollapsibleTrigger
      render={<Button className="-ml-2.5" size="sm" variant="ghost" />}
    >
      <ChevronRightIcon className="text-muted-foreground transition-transform group-aria-expanded/button:rotate-90" />
      {title}
      {count === undefined ? null : (
        <span className="text-muted-foreground">{count}</span>
      )}
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div className="flex flex-col gap-5 pt-2 pb-4">{children}</div>
    </CollapsibleContent>
  </Collapsible>
);
