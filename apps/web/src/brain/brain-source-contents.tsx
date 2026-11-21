import { Plural, Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { formatList, formatNumber } from "../format.ts";
import { RouterLink } from "../frame/router-link.tsx";
import { Button } from "../grasp/button/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../grasp/table/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Note, SourceContents, TeamRow } from "./brain.ts";

// What an import brought in, as the prototype shows it
// (`components/brain-source-contents.tsx`).

/** How many rows show before the rest folds, so a long import stays one screen. */
const show = 10;

const styles = stylex.create({
  // Set apart from the note above it by a hairline.
  section: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    paddingBlockStart: grasp.space6,
    borderBlockStartWidth: grasp.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
  },
  start: { alignSelf: "flex-start" },
});

/** A name that opens its note, or plain words when the brain has no note for it. */
const NoteName = ({
  id,
  byId,
  children,
}: {
  id: string;
  byId: Map<string, Note>;
  /** The team's name. */
  children: string;
}) => {
  if (!byId.has(id)) {
    return children;
  }
  return (
    <RouterLink
      params={{ noteId: id }}
      to="/brain/$noteId"
      variant="standalone"
    >
      {children}
    </RouterLink>
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
    <Table aria-label={t`Teams and roles`}>
      <TableHeader>
        <TableRow>
          <TableHead>
            <Trans>Team</Trans>
          </TableHead>
          <TableHead align="end">
            <Trans context="column: how many people">People</Trans>
          </TableHead>
          <TableHead>
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
              <TableCell lead>
                <NoteName byId={byId} id={row.teamId}>
                  {byId.get(row.teamId)?.title ?? row.teamId}
                </NoteName>
              </TableCell>
              <TableCell align="end">
                {people}
                {before === undefined ? null : (
                  <Text element="span" size="sm" tone="muted">
                    {" "}
                    <Trans context="a number that changed: what it was before">
                      (was {before})
                    </Trans>
                  </Text>
                )}
              </TableCell>
              <TableCell wrap>
                <Text element="span" size="sm" tone="muted">
                  {row.roles.length > 0
                    ? formatList(
                        row.roles.map((role) =>
                          role.people === null
                            ? role.name
                            : `${role.name} (${formatNumber(role.people)})`
                        )
                      )
                    : t`Not listed`}
                </Text>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
};

/**
 * What an import brought in, as a table: the teams and roles from a directory. This is the context
 * the team notes are drawn from; each name opens its note.
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
    <section {...stylex.props(styles.section)}>
      <Heading level={2} size="ui-sm">
        <Trans>Teams and roles</Trans>{" "}
        <Text element="span" size="sm" tone="muted">
          {formatNumber(rows)}
        </Text>
      </Heading>
      <TeamTable
        byId={byId}
        rows={hidden > 0 ? contents.rows.slice(0, show) : contents.rows}
      />
      {hidden > 0 ? (
        <Button
          layout={styles.start}
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
