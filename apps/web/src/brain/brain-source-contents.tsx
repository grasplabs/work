import { Button } from "@grasp-os/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { AppLogo } from "../connections/app-logo.tsx";
import { formatList, formatNumber } from "../format.ts";
import type { AppRow, Note, SourceContents, TeamRow } from "./brain.ts";

// What an import brought in, as the prototype shows it
// (`components/brain-source-contents.tsx`).

/** How many rows show before the rest folds, so a long import stays one screen. */
const show = 10;

/** A name that opens its note, or plain words when the brain has no note for it. */
const NoteName = ({
  id,
  byId,
  children,
}: {
  id: string;
  byId: Map<string, Note>;
  children: ReactNode;
}) => {
  if (!byId.has(id)) {
    return <span className="flex min-w-0 items-center gap-2">{children}</span>;
  }
  return (
    <Link
      className="flex min-w-0 items-center gap-2 hover:underline"
      params={{ noteId: id }}
      to="/brain/$noteId"
    >
      {children}
    </Link>
  );
};

const TeamTable = ({
  rows,
  byId,
}: {
  rows: TeamRow[];
  byId: Map<string, Note>;
}) => {
  const { t } = useLingui();
  const unknown = t({ message: "Unknown", context: "number of people" });
  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-36 @md:w-48" variant="card">
            <Trans>Team</Trans>
          </TableHead>
          <TableHead className="w-20 @md:w-28" variant="card">
            <Trans context="column: how many people">People</Trans>
          </TableHead>
          <TableHead variant="card">
            <Trans>Roles</Trans>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const countOf = (count: number | null): string =>
            count === null ? unknown : formatNumber(count);
          const people = countOf(row.people);
          const before =
            row.before === undefined ? undefined : countOf(row.before);
          return (
            <TableRow key={row.teamId}>
              <TableCell variant="card">
                <NoteName byId={byId} id={row.teamId}>
                  <span className="truncate">
                    {byId.get(row.teamId)?.title ?? row.teamId}
                  </span>
                </NoteName>
              </TableCell>
              <TableCell variant="card">
                <span className="tabular-nums">
                  {people}
                  {before === undefined ? null : (
                    <span className="text-muted-foreground">
                      {" "}
                      <Trans context="a number that changed: what it was before">
                        (was {before})
                      </Trans>
                    </span>
                  )}
                </span>
              </TableCell>
              <TableCell className="whitespace-normal" variant="card">
                <span className="text-muted-foreground">
                  {row.roles.length > 0
                    ? formatList(
                        row.roles.map((role) =>
                          role.people === null
                            ? role.name
                            : `${role.name} (${formatNumber(role.people)})`
                        )
                      )
                    : t`Not listed`}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
};

/**
 * Sign-in shows what each application may do: the permissions people granted it. Pulse shows what
 * runs on devices, so there the column that matters is whether any team named it.
 */
const AppTable = ({
  rows,
  signIn,
  byId,
}: {
  rows: AppRow[];
  signIn: boolean;
  byId: Map<string, Note>;
}) => {
  const { t } = useLingui();
  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-36 @md:w-52" variant="card">
            <Trans>Application</Trans>
          </TableHead>
          <TableHead className="w-20 @md:w-24" variant="card">
            <Trans context="column: how many people">People</Trans>
          </TableHead>
          <TableHead variant="card">
            {signIn ? (
              <Trans context="column: the OAuth permissions granted to an application">
                Permissions
              </Trans>
            ) : (
              <Trans context="column: whether a team named the application in a conversation">
                Named
              </Trans>
            )}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ app, noteId, named }) => (
          <TableRow key={app.id}>
            <TableCell variant="card">
              <NoteName byId={byId} id={noteId}>
                <AppLogo name={app.name} size="xs" />
                <span className="truncate">{app.name}</span>
              </NoteName>
            </TableCell>
            <TableCell variant="card">
              <span className="tabular-nums">{formatNumber(app.people)}</span>
            </TableCell>
            {signIn ? (
              <TableCell
                className="whitespace-normal"
                title={app.permissions.join("\n")}
                variant="card"
              >
                <span className="text-muted-foreground line-clamp-2">
                  {formatList(app.permissions)}
                </span>
              </TableCell>
            ) : (
              <TableCell variant="card">
                <span className="text-muted-foreground">
                  {named
                    ? t({
                        message: "By a team",
                        comment: "Column value: a team named this application",
                      })
                    : t({
                        message: "By nobody",
                        comment: "Column value: no team named this application",
                      })}
                </span>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

/** What an import's table holds, as its heading says it. */
const ContentsHeading = ({ contents }: { contents: SourceContents }) => {
  if (contents.kind === "teams") {
    return <Trans>Teams and roles</Trans>;
  }
  return contents.signIn ? (
    <Trans>Applications signed in to</Trans>
  ) : (
    <Trans>Applications in use on devices</Trans>
  );
};

/**
 * What an import brought in, as a table: the teams and roles from a directory, or the applications
 * seen through sign-in or Pulse. This is the context the team, tool and application notes are drawn
 * from; each name opens its note.
 */
export const SourceContentsTable = ({
  contents,
  byId,
}: {
  contents: SourceContents;
  byId: Map<string, Note>;
}) => {
  const [open, setOpen] = useState(false);
  const rows = contents.rows.length;
  const hidden = open || rows <= show + 1 ? 0 : rows - show;
  return (
    <section className="flex flex-col gap-2 border-t pt-6">
      <h2 className="flex items-baseline gap-2 text-sm font-medium">
        <ContentsHeading contents={contents} />
        <span className="text-muted-foreground font-normal">
          {formatNumber(rows)}
        </span>
      </h2>
      <div className="bg-background overflow-hidden rounded-lg border">
        {contents.kind === "teams" ? (
          <TeamTable
            byId={byId}
            rows={hidden > 0 ? contents.rows.slice(0, show) : contents.rows}
          />
        ) : (
          <AppTable
            byId={byId}
            rows={hidden > 0 ? contents.rows.slice(0, show) : contents.rows}
            signIn={contents.signIn}
          />
        )}
      </div>
      {hidden > 0 ? (
        <Button
          className="-ml-2 self-start"
          onClick={() => {
            setOpen(true);
          }}
          size="xs"
          variant="ghost"
        >
          <Plural one="Show # more" other="Show # more" value={hidden} />
        </Button>
      ) : null}
    </section>
  );
};
