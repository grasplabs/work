/**
 * What Grasp keeps of the interviews at one company, ported from the
 * prototype (grasplabs/prototype `components/admin/org-data.tsx`): how much
 * is kept, who had their interview deleted, and what the
 * company itself gets to see. Every figure is the model's (`keptOf`,
 * `companySees`); nothing anyone said is shown, only names and numbers.
 *
 * Not here, as the prototype has it: the number of words in the first
 * conversation (the admin never holds what was said, so it says only how
 * far that conversation is), and the way to the transcripts (core keeps
 * them back).
 */

import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import { MIN_GROUP } from "@grasp-os/shared/admin/interviews";
import { DELETE_DAYS, peopleOf } from "@grasp-os/shared/admin/onboarding-admin";
import type { OrgState } from "@grasp-os/shared/admin/onboarding-admin";
import {
  companySees,
  keptOf,
} from "@grasp-os/shared/admin/onboarding-admin-record";
import { CardContent } from "@grasp-os/ui/components/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Text } from "@grasp-os/ui/components/text";
import { colors, font } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

import { Panel, PanelNote, PanelRow, PanelRows } from "./panel.tsx";

const styles = stylex.create({
  figure: { fontVariantNumeric: "tabular-nums" },
  muted: { color: colors.mutedForeground },
  // A name with its quiet lines under it.
  lines: { display: "flex", flexDirection: "column" },
  small: {
    fontSize: font.textXs,
    fontWeight: font.weightNormal,
    color: colors.mutedForeground,
  },
  // Said under the name only where the People column is left out.
  narrowOnly: {
    display: { default: null, "@container (width >= 40rem)": "none" },
  },
});

const percent = new Intl.NumberFormat("en", {
  style: "percent",
  maximumFractionDigits: 0,
});

/** So many of so many, as a share; nothing of nothing has none. */
const share = (done: number, of: number): string =>
  of === 0 ? "–" : percent.format(done / of);

/** `count` people, in words. */
const peopleWords = (count: number): string =>
  `${count} ${count === 1 ? "person" : "people"}`;

/** How far the first conversation is, as the model has it: never its words. */
const conversationWords: Record<OrgState["conversation"], string> = {
  none: "Not brought in yet",
  in: "Brought in",
  read: "Read by Stephen",
};

/** What is kept, as counts: the fixed rules people are told (no voice is kept) aren't repeated for every company. */
const WhatIsKept = ({ view }: { view: AdminView }) => {
  // Counted up to the day the view is on, which runs on past the interviews' close.
  const kept = keptOf(view, view.asOf);
  const { conversation } = view.state;
  return (
    <Panel title="What is kept">
      <PanelRows>
        <PanelRow label="The first conversation">
          <span {...stylex.props(conversation === "none" && styles.muted)}>
            {conversationWords[conversation]}
          </span>
        </PanelRow>
        <PanelRow label="Interviews people agreed to">
          <span {...stylex.props(styles.figure)}>{kept.agreed}</span>
        </PanelRow>
        <PanelRow label="Interviews that stopped halfway">
          <span {...stylex.props(styles.figure)}>{kept.halfway}</span>
        </PanelRow>
        <PanelRow
          label={`Can still be deleted, for ${DELETE_DAYS} days after the interview`}
        >
          <span {...stylex.props(styles.figure)}>{kept.deletable}</span>
        </PanelRow>
      </PanelRows>
    </Panel>
  );
};

const Deleted = ({ view }: { view: AdminView }) => {
  const { org, state } = view;
  const deleted = peopleOf(org).filter((person) =>
    state.deleted.includes(person.id)
  );
  return (
    <Panel
      description="Their words are gone, and with them what only they said. Their name stays, so nobody is asked again."
      title="Deleted because they asked"
    >
      {deleted.length === 0 ? (
        <PanelNote>Nobody asked.</PanelNote>
      ) : (
        <CardContent flush>
          <ItemGroup separated>
            {deleted.map((person) => (
              <Item key={person.id} size="sm">
                <ItemContent>
                  <ItemTitle>{person.name}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Text as="span" color="muted">
                    {org.teams.find((team) => team.id === person.team)?.name ??
                      ""}
                  </Text>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </CardContent>
      )}
    </Panel>
  );
};

/** A row's numbers: its people, and how many completed and stopped, none for a team too small to show. */
const Figures = ({
  people,
  completed,
  stopped,
}: {
  people: number;
  completed: number | null;
  stopped: number | null;
}) => (
  <>
    <TableCell align="end" hideBelow="sm">
      <span {...stylex.props(styles.figure)}>{people}</span>
    </TableCell>
    <TableCell align="end">
      <span {...stylex.props(styles.figure)}>{completed ?? "–"}</span>
    </TableCell>
    <TableCell align="end" hideBelow="md">
      <span {...stylex.props(styles.figure)}>{stopped ?? "–"}</span>
    </TableCell>
    <TableCell align="end" hideBelow="sm">
      <span {...stylex.props(styles.figure)}>
        {completed === null ? "–" : share(completed, people)}
      </span>
    </TableCell>
  </>
);

const CompanySees = ({ view }: { view: AdminView }) => {
  const sees = companySees(view);
  return (
    <Panel
      description={`Numbers per team, only where ${MIN_GROUP} or more in a team are asked to talk, and for everyone only the teams that show theirs. Never a name, never anyone’s words, and never who stopped or did not start.`}
      title="What the company itself sees"
    >
      {sees.teams.length === 0 ? (
        <PanelNote>
          Nothing yet. The teams come with the company’s own sign-in.
        </PanelNote>
      ) : (
        <CardContent flush>
          <Table aria-label="What the company itself sees">
            <TableHeader>
              <TableRow>
                <TableHead>Team</TableHead>
                <TableHead align="end" hideBelow="sm">
                  People
                </TableHead>
                <TableHead align="end">Completed</TableHead>
                <TableHead align="end" hideBelow="md">
                  Stopped halfway
                </TableHead>
                <TableHead align="end" hideBelow="sm">
                  Share completed
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sees.teams.map((team) => (
                <TableRow key={team.team.id}>
                  <TableCell wrap>
                    <span {...stylex.props(styles.lines)}>
                      {team.team.name}
                      {/* Where there is no room for a column of its own, the number of people goes under the name. */}
                      <span
                        {...stylex.props(
                          styles.small,
                          styles.figure,
                          styles.narrowOnly
                        )}
                      >
                        {peopleWords(team.people)}
                      </span>
                      {team.shown ? null : (
                        <span {...stylex.props(styles.small)}>
                          Too small to show
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <Figures
                    completed={team.shown ? team.completed : null}
                    people={team.people}
                    stopped={team.shown ? team.stopped : null}
                  />
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell>
                  <span {...stylex.props(styles.lines)}>
                    Everyone
                    <span
                      {...stylex.props(
                        styles.small,
                        styles.figure,
                        styles.narrowOnly
                      )}
                    >
                      {peopleWords(sees.people)}
                    </span>
                  </span>
                </TableCell>
                <Figures
                  completed={sees.completed}
                  people={sees.people}
                  stopped={sees.stopped}
                />
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      )}
    </Panel>
  );
};

/** An organization's Data: what is kept, what was deleted, and what the company sees. */
export const OrgData = ({ view }: { view: AdminView }) => (
  <>
    <WhatIsKept view={view} />
    <Deleted view={view} />
    <CompanySees view={view} />
  </>
);
