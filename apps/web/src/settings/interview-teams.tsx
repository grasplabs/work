import { failureText } from "@grasp-os/shared/errors";
import {
  leadsOfTeam,
  minTalkedShown,
  minTeamShown,
} from "@grasp-os/shared/onboarding";
import type { OnboardingView } from "@grasp-os/shared/onboarding";
import type {
  Campaign,
  CampaignTeam,
} from "@grasp-os/shared/onboarding-campaign";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import { Progress } from "@grasp-os/ui/components/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import type { TableSortDirection } from "@grasp-os/ui/components/table";
import { Text } from "@grasp-os/ui/components/text";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";

import { formatList } from "../format.ts";
import {
  isGrouped,
  rowName,
  say,
} from "../onboarding/campaign/campaign-words.ts";
import { useCore } from "../use-core.ts";
import { everyoneTalked, runsToday, stillToTalk } from "./interview-rows.ts";
import { interviewStyles as styles } from "./interviews.styles.ts";
import { RowAlert, SettingsGroup } from "./section.tsx";

// Settings › Interviews › Teams: every team that takes part in one table,
// in numbers by core's own rules (a team's numbers once `minTeamShown`
// were asked, how many talked once `minTalkedShown` did), never who talked
// or what anyone said. Its lead is named, as the staff list names them.
// The admin ticks teams and sends them Grasp's reminder in one press
// (`onboarding.nudge`, once per team): it goes to whoever in the team
// hasn't finished, whom the admin never sees. Core takes one a day for a
// team and none for a team under five; a team it would refuse can't be
// ticked, and what it refuses all the same is said per team.

/** One team as the table shows it. */
interface TeamRow {
  team: CampaignTeam;
  name: string;
  /** Its leads' names, as the staff list has them; none for an erased lead. */
  leads: string[];
  waiting: number | null;
  remindedToday: boolean;
  /** Why it can't be reminded now; undefined where it can. */
  refused: string | undefined;
}

/** The names of a team's leads, as the staff list has them; none for an erased lead. */
const leadNames = (view: OnboardingView, team: string): string[] => {
  const listed = view.roster?.teams.find(({ id }) => id === team);
  if (listed === undefined) {
    return [];
  }
  const names = new Map(
    view.roster?.people.map((person) => [person.id, person.name])
  );
  return leadsOfTeam(listed).flatMap((lead) => {
    const name = names.get(lead) ?? "";
    return name === "" ? [] : [name];
  });
};

/** The columns the rows sort by. */
type SortKey = "team" | "lead" | "asked" | "talked" | "waiting" | "progress";

interface Sort {
  key: SortKey;
  order: "ascending" | "descending";
}

/** What a row sorts by in a column; null where core hides it, or there is none. */
const sortValue = (row: TeamRow, key: SortKey): string | number | null => {
  const { team } = row;
  switch (key) {
    case "team": {
      return row.name;
    }
    case "lead": {
      return row.leads[0] ?? null;
    }
    case "asked": {
      return team.asked;
    }
    case "talked": {
      return team.talked;
    }
    case "waiting": {
      return row.waiting;
    }
    case "progress": {
      return team.asked === null || team.talked === null || team.asked === 0
        ? null
        : team.talked / team.asked;
    }
    default: {
      return null;
    }
  }
};

/**
 * The rows in order: by the column, and whatever core hides (or a team
 * without a lead, by lead) last either way. A hidden team with more asked
 * stands before one with fewer; the rest keep the staff list's order.
 */
const sorted = (rows: readonly TeamRow[], sort: Sort): TeamRow[] => {
  const turn = sort.order === "ascending" ? 1 : -1;
  return rows.toSorted((one, other) => {
    const a = sortValue(one, sort.key);
    const b = sortValue(other, sort.key);
    if (a === null || b === null) {
      if (a !== null) {
        return -1;
      }
      if (b !== null) {
        return 1;
      }
      return (other.team.asked ?? -1) - (one.team.asked ?? -1);
    }
    if (typeof a === "string" || typeof b === "string") {
      return turn * String(a).localeCompare(String(b));
    }
    return turn * (a - b);
  });
};

/** A column's name, pressed to sort by it, and again to turn the order over. */
const SortHead = ({
  column,
  sort,
  onSort,
  align,
  children,
}: {
  column: SortKey;
  sort: Sort;
  onSort: (next: Sort) => void;
  align?: "end";
  children: string;
}) => {
  const direction: TableSortDirection =
    sort.key === column ? sort.order : "none";
  return (
    <TableHead
      {...(align === undefined ? {} : { align })}
      column={column}
      onSort={() => {
        onSort({
          key: column,
          order: direction === "ascending" ? "descending" : "ascending",
        });
      }}
      sortDirection={direction}
    >
      {children}
    </TableHead>
  );
};

/** A team's tick: out of use, with why, where no reminder can go to it now. */
const TeamTick = ({
  row,
  checked,
  onChange,
}: {
  row: TeamRow;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) => {
  const { t } = useLingui();
  const why = useId();
  const { name, refused } = row;
  if (refused === undefined) {
    return (
      <Checkbox
        aria-label={t`Select ${name}`}
        checked={checked}
        onCheckedChange={(next) => {
          onChange(next === true);
        }}
      />
    );
  }
  // The reason stands in the trigger, hidden, so the tick's own words say
  // it where no pointer rests on it; the tooltip shows the same.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span {...stylex.props(styles.inline)}>
          <Checkbox
            aria-describedby={why}
            aria-label={t`Select ${name}`}
            checked={false}
            disabled
          />
          <span id={why} {...stylex.props(visuallyHidden)}>
            {refused}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{refused}</TooltipContent>
    </Tooltip>
  );
};

/** A team's lead by name, and that they haven't talked yet where they haven't. */
const LeadCell = ({ row }: { row: TeamRow }) => {
  const { t } = useLingui();
  const { team, leads } = row;
  if (!team.led) {
    return <Text as="span" color="muted" size="sm">{t`No lead`}</Text>;
  }
  return (
    <span {...stylex.props(styles.lead)}>
      {leads.length === 0 ? null : <span>{formatList(leads)}</span>}
      {team.leadTalked ? null : (
        <Text as="span" color="muted" size="xs">
          {t`Hasn’t talked yet`}
        </Text>
      )}
    </span>
  );
};

/** A team's numbers: each in its column, or one muted line across what core hides. */
const NumberCells = ({ row }: { row: TeamRow }) => {
  const { t } = useLingui();
  const { team, name, waiting } = row;
  const { asked, talked } = team;
  const hidden = (
    <Text as="span" color="muted" size="sm">{t`Too few to show`}</Text>
  );
  if (asked === null) {
    return <TableCell colSpan={4}>{hidden}</TableCell>;
  }
  if (talked === null || waiting === null) {
    return (
      <>
        <TableCell align="end">{asked}</TableCell>
        <TableCell colSpan={3}>{hidden}</TableCell>
      </>
    );
  }
  return (
    <>
      <TableCell align="end">{asked}</TableCell>
      <TableCell align="end">{talked}</TableCell>
      <TableCell align="end">{waiting}</TableCell>
      <TableCell>
        <Progress
          aria-label={t`How many of ${name} talked`}
          getAriaValueText={() => t`${talked} of ${asked}`}
          max={Math.max(asked, 1)}
          size="sm"
          style={styles.bar}
          value={talked}
          variant={talked >= asked ? "success" : "default"}
        />
      </TableCell>
    </>
  );
};

/** Where a team stands, in one badge, or none. */
const StatusBadge = ({ row }: { row: TeamRow }) => {
  const { t } = useLingui();
  if (everyoneTalked(row.team)) {
    return <Badge size="sm" variant="success">{t`Everyone talked`}</Badge>;
  }
  if (row.remindedToday) {
    return <Badge size="sm" variant="secondary">{t`Reminded today`}</Badge>;
  }
  return row.team.quiet ? (
    <Badge size="sm" variant="warning">{t`Quiet`}</Badge>
  ) : null;
};

/** What became of a press on Send reminder. */
interface Outcome {
  /** How many people were mailed, in how many teams. */
  mailed: number;
  teams: number;
  /** The teams core sent none to, each with why. */
  refusals: { id: string; name: string; why: string }[];
}

/** What a press did, said once: who was mailed, then each team that got none. */
const OutcomeLines = ({ outcome }: { outcome: Outcome }) => {
  const { t } = useLingui();
  const { mailed, teams } = outcome;
  return (
    <>
      {teams === 0 ? null : (
        <RowAlert variant="success">
          {t`${plural(mailed, {
            one: "Your reminder went to # person",
            other: "Your reminder went to # people",
          })} ${plural(teams, {
            one: "in # team.",
            other: "in # teams.",
          })}`}
        </RowAlert>
      )}
      {outcome.refusals.map(({ id, name, why }) => (
        <RowAlert key={id} variant="warning">
          {t`${name} got no reminder. ${why}`}
        </RowAlert>
      ))}
    </>
  );
};

/** Every team that takes part: its numbers, its lead, and the reminder to those ticked. */
export const InterviewTeams = ({
  campaign,
  view,
  onChanged,
}: {
  campaign: Campaign;
  view: OnboardingView;
  onChanged: () => Promise<void>;
}) => {
  const { t, i18n } = useLingui();
  const core = useCore();
  const [sort, setSort] = useState<Sort>({
    key: "waiting",
    order: "descending",
  });
  const [ticked, setTicked] = useState<readonly string[]>([]);
  // The teams this page reminded: core says so again only for a quiet team.
  const [reminded, setReminded] = useState<readonly string[]>([]);
  const [outcome, setOutcome] = useState<Outcome>();
  const leastAsked = minTeamShown;
  const leastTalked = minTalkedShown;
  const grouped = isGrouped(campaign);
  const runs = runsToday(campaign);
  const rows = campaign.teams.map((team): TeamRow => {
    const remindedToday =
      reminded.includes(team.id) ||
      campaign.asks.some(
        (ask) => ask.kind === "quiet" && ask.team === team.id && ask.nudged
      );
    let refused: string | undefined;
    if (!runs) {
      refused = t`A reminder goes only on the days the interviews run.`;
    } else if (team.asked === null) {
      refused = t`Fewer than ${leastAsked} people were asked in this team, so no reminder goes to it.`;
    } else if (everyoneTalked(team)) {
      refused = t`Everyone in this team has talked.`;
    } else if (remindedToday) {
      refused = t`This team got your reminder today. The next one can go tomorrow.`;
    }
    return {
      team,
      name: say(i18n, rowName(team, grouped)),
      leads: leadNames(view, team.id),
      waiting: stillToTalk(team),
      remindedToday,
      refused,
    };
  });
  const open = rows.filter((row) => row.refused === undefined);
  const chosen = open.filter((row) => ticked.includes(row.team.id));
  const count = chosen.length;
  let all: boolean | "indeterminate" = false;
  if (count > 0) {
    all = count === open.length ? true : "indeterminate";
  }
  const send = async (): Promise<void> => {
    const done: Outcome = { mailed: 0, teams: 0, refusals: [] };
    const went: string[] = [];
    // One team after the other: each is its own mail run and its own audit event.
    for (const { team, name } of chosen) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- in order, so a refusal never races the next team
        const sent = await core.withSession(
          async (session) => await session.onboarding.nudge(team.id)
        );
        done.mailed += sent.mailed;
        done.teams += 1;
        went.push(team.id);
      } catch (error) {
        done.refusals.push({ id: team.id, name, why: failureText(error) });
      }
    }
    setOutcome(done);
    setReminded([...reminded, ...went]);
    setTicked([]);
    await onChanged();
  };
  return (
    <SettingsGroup
      actions={
        <Button
          disabled={count === 0}
          // The press empties the selection: the button keeps the focus all the same.
          focusableWhenDisabled
          loadingText={t`Sending`}
          onClick={send}
          size="sm"
        >
          {count === 0
            ? t`Send reminder`
            : plural(count, {
                one: "Send reminder to # team",
                other: "Send reminder to # teams",
              })}
        </Button>
      }
      description={t`Tick teams to send Grasp’s reminder to everyone in them who hasn’t finished, once a day at most.`}
      flush
      info={t`A team shows its numbers once ${leastAsked} people in it were asked and ${leastTalked} have talked, so nobody can be singled out. Nobody here sees who talked or what anyone said.`}
      title={t`Teams`}
    >
      {outcome === undefined ? null : <OutcomeLines outcome={outcome} />}
      <Table aria-label={t`Teams`}>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Checkbox
                aria-label={t`Select every team a reminder can go to`}
                checked={all}
                disabled={open.length === 0}
                onCheckedChange={(next) => {
                  setTicked(
                    next === true ? open.map(({ team }) => team.id) : []
                  );
                }}
              />
            </TableHead>
            <SortHead column="team" onSort={setSort} sort={sort}>
              {t`Team`}
            </SortHead>
            <SortHead column="lead" onSort={setSort} sort={sort}>
              {t`Lead`}
            </SortHead>
            <SortHead align="end" column="asked" onSort={setSort} sort={sort}>
              {t({
                message: "Asked",
                context: "how many people were asked to talk",
              })}
            </SortHead>
            <SortHead align="end" column="talked" onSort={setSort} sort={sort}>
              {t`Talked`}
            </SortHead>
            <SortHead align="end" column="waiting" onSort={setSort} sort={sort}>
              {t`Still to talk`}
            </SortHead>
            <SortHead column="progress" onSort={setSort} sort={sort}>
              {t`Progress`}
            </SortHead>
            <TableHead>{t`Status`}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted(rows, sort).map((row) => {
            const { id } = row.team;
            const isTicked = row.refused === undefined && ticked.includes(id);
            return (
              <TableRow key={id} selected={isTicked}>
                <TableCell>
                  <TeamTick
                    checked={isTicked}
                    onChange={(next) => {
                      setTicked(
                        next
                          ? [...ticked, id]
                          : ticked.filter((each) => each !== id)
                      );
                    }}
                    row={row}
                  />
                </TableCell>
                <TableCell rowHeader>{row.name}</TableCell>
                <TableCell>
                  <LeadCell row={row} />
                </TableCell>
                <NumberCells row={row} />
                <TableCell>
                  <StatusBadge row={row} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </SettingsGroup>
  );
};
