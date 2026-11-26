import { leadsOfTeam, noTeamId } from "@grasp-os/shared/onboarding";
import type { RosterPerson, RosterTeam } from "@grasp-os/shared/onboarding";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Button } from "@grasp-os/ui/components/button";
import { Card } from "@grasp-os/ui/components/card";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import type { CheckedState } from "@grasp-os/ui/components/checkbox";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupClear,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { Text } from "@grasp-os/ui/components/text";
import { Toggle } from "@grasp-os/ui/components/toggle";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Icon,
  SearchIcon,
  UserPlusIcon,
} from "@grasp-os/ui/lib/icons";
import { colors, media, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { formatList } from "../format.ts";
import { TopError } from "../frame/top-error.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { CalmStep } from "./calm-frame.tsx";
import { WaitingNote } from "./company-step.tsx";
import { ForgetTeams } from "./forget-teams.tsx";
import { LeadStar } from "./lead-star.tsx";
import { PeopleAdd } from "./people-add.tsx";
import { personRowMarker } from "./people-list.stylex.ts";
import {
  countsOf,
  found,
  leadIdsOf,
  leads,
  noPicks,
  takesPart,
  teamRowsOf,
  TooManyPeopleError,
  withAdded,
  withLead,
  withTaking,
} from "./people-picks.ts";
import type { Picks } from "./people-picks.ts";
import { suiteNames, useRefresh } from "./step-parts.ts";
import type { StepProps } from "./step-parts.ts";
import { useAnswer, useLeaving } from "./step-voice.tsx";
import { orgConfirmed, orgDraft } from "./visit.ts";

// Who Stephen talks to (Ruben: no HR platform; the people come from the
// Microsoft or Google directory the company step connected). Everyone it
// gave is on one list, by team: the admin unticks who doesn't take part,
// a whole team at once if they like, and marks each team's leads, whom
// Stephen talks to first. Someone missing, or no directory at all: they
// add people by address or with a staff list. Nothing goes to core until
// Continue, which confirms the organization as it stands (core checks it
// is the admin, and every address).

/** More people than this, and each team opens on its own press. */
const openUpTo = 30;
/** The most rows one team shows before a press shows the rest. */
const rowsShown = 150;

const styles = stylex.create({
  stack: { display: "grid", gap: space[4] },
  toolbar: {
    display: "grid",
    gap: space[3],
    padding: space[3],
  },
  // Everyone at once, and how many take part.
  all: {
    display: "flex",
    alignItems: "center",
    gap: space[3],
    paddingInline: space[1],
  },
  list: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    maxHeight: "min(32rem, 60svh)",
    overflowY: "auto",
    scrollbarWidth: "thin",
  },
  team: {
    position: "sticky",
    insetBlockStart: 0,
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    gap: space[3],
    minHeight: "2.75rem",
    paddingInline: space[4],
    backgroundColor: colors.muted,
    borderBlockEndWidth: size.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
  },
  teamName: { flexGrow: 1, minWidth: 0 },
  // A team's name is the press that opens it: no box drawn round it.
  opener: {
    display: "flex",
    alignItems: "center",
    gap: space[2],
    flexGrow: 1,
    minWidth: 0,
    padding: 0,
    border: "none",
    background: "none",
    color: "inherit",
    font: "inherit",
    textAlign: "start",
    cursor: "pointer",
    outline: { ":focus-visible": "none" },
    textDecorationLine: { default: "none", ":focus-visible": "underline" },
  },
  person: {
    display: "flex",
    alignItems: "center",
    gap: space[3],
    minHeight: "3.25rem",
    paddingInline: space[4],
    borderBlockEndWidth: size.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
  },
  // The whole row ticks the box: the name, the job, the space between.
  pick: {
    display: "flex",
    alignItems: "center",
    gap: space[3],
    flexGrow: 1,
    minWidth: 0,
    cursor: "pointer",
  },
  words: { display: "grid", minWidth: 0 },
  out: { opacity: 0.55 },
  // A lead's mark always shows; anyone else's only while the row is pointed at or in focus, so
  // the list stays calm. Without a pointer that hovers, it always shows.
  lead: {
    opacity: {
      default: 1,
      [media.hover]: {
        default: 0,
        [stylex.when.ancestor(":hover", personRowMarker)]: 1,
        [stylex.when.ancestor(":focus-within", personRowMarker)]: 1,
      },
    },
  },
  leadOn: { opacity: 1 },
  more: { display: "flex", justifyContent: "center", padding: space[3] },
});

/** One person: ticked to take part, and marked as their team's lead. */
const PersonRow = ({
  person,
  taking,
  lead,
  teamName,
  onTaking,
  onLead,
}: {
  person: RosterPerson;
  taking: boolean;
  lead: boolean;
  /** Their team, while the list is searched and no longer by team. */
  teamName: string | null;
  onTaking: (on: boolean) => void;
  onLead: (on: boolean) => void;
}) => {
  const { t } = useLingui();
  const name = person.name === "" ? t`Erased` : person.name;
  const about = [person.title || person.email, teamName]
    .filter(Boolean)
    .join(" · ");
  return (
    <li {...stylex.props(personRowMarker, styles.person)}>
      <label {...stylex.props(styles.pick, !taking && styles.out)}>
        <Checkbox
          checked={taking}
          onCheckedChange={(on) => {
            onTaking(on === true);
          }}
        />
        <Avatar decorative name={name} size="sm">
          <AvatarFallback />
        </Avatar>
        <span {...stylex.props(styles.words)}>
          <Text as="span" color="default" truncate>
            {name}
          </Text>
          {about === "" ? null : (
            <Text as="span" color="muted" size="sm" truncate>
              {about}
            </Text>
          )}
        </span>
      </label>
      <span {...stylex.props(styles.lead, lead && styles.leadOn)}>
        <Toggle
          aria-label={t`${name} leads the team`}
          onPressedChange={onLead}
          pressed={lead}
          size="xs"
          variant="outline"
        >
          <LeadStar on={lead} />
          {t`Lead`}
        </Toggle>
      </span>
    </li>
  );
};

/** A team's box: ticked when everyone in it takes part, a dash when some do. */
const checkedOf = (taking: number, all: number): CheckedState => {
  if (taking === 0) {
    return false;
  }
  return taking === all ? true : "indeterminate";
};

/** One team: its box ticks everyone in it, its name opens it. */
const TeamRow = ({
  team,
  people,
  picks,
  open,
  searching,
  onOpen,
  onPicks,
}: {
  team: RosterTeam;
  people: RosterPerson[];
  picks: Picks;
  open: boolean;
  searching: boolean;
  onOpen: (open: boolean) => void;
  onPicks: (picks: Picks) => void;
}) => {
  const { t } = useLingui();
  const [all, setAll] = useState(false);
  const taking = people.filter((person) => takesPart(picks, person)).length;
  // Its leads by name, the first first: "Sales · led by Ann and Bob" while closed.
  const ledBy = leadsOfTeam(team).flatMap((id) => {
    const lead = people.find((person) => person.id === id);
    return lead === undefined ? [] : [lead.name];
  });
  const counted = searching
    ? plural(people.length, { one: "# found", other: "# found" })
    : t`${taking} of ${people.length}`;
  const shown = all ? people : people.slice(0, rowsShown);
  return (
    <>
      <li {...stylex.props(styles.team)}>
        <Checkbox
          aria-label={t`Everyone in ${team.name}`}
          checked={checkedOf(taking, people.length)}
          onCheckedChange={(on) => {
            onPicks(
              withTaking(
                picks,
                new Set(people.map(({ id }) => id)),
                on === true
              )
            );
          }}
        />
        <button
          aria-expanded={open}
          onClick={() => {
            onOpen(!open);
          }}
          type="button"
          {...stylex.props(styles.opener)}
        >
          <span {...stylex.props(styles.teamName)}>
            <Text as="span" color="default" truncate weight="medium">
              {ledBy.length === 0 || open
                ? team.name
                : t`${team.name} · led by ${formatList(ledBy)}`}
            </Text>
          </span>
          <Text as="span" color="subtle" size="sm">
            {counted}
          </Text>
          <Icon icon={open ? ChevronDownIcon : ChevronRightIcon} />
        </button>
      </li>
      {open
        ? shown.map((person) => (
            <PersonRow
              key={person.id}
              lead={leads(picks, person)}
              onLead={(on) => {
                onPicks(withLead(picks, person.id, on));
              }}
              onTaking={(on) => {
                onPicks(withTaking(picks, new Set([person.id]), on));
              }}
              person={person}
              taking={takesPart(picks, person)}
              teamName={null}
            />
          ))
        : null}
      {open && shown.length < people.length ? (
        <li {...stylex.props(styles.more)}>
          <Button
            onClick={() => {
              setAll(true);
            }}
            size="sm"
            variant="ghost"
          >
            {t`Show all ${people.length}`}
          </Button>
        </li>
      ) : null}
    </>
  );
};

/** The list: searched, everyone at once, and by team. */
const PeopleList = ({
  picks,
  onPicks,
  noTeam,
}: {
  picks: Picks;
  onPicks: (picks: Picks) => void;
  noTeam: string;
}) => {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const searching = query.trim() !== "";
  const shown = found(picks, query);
  // The leads as a team was last opened stand first in it; marking another moves no row, so its
  // star plays where it was pressed. Opening or closing a team brings the leads up again.
  const leadsNow = (): ReadonlySet<string> => leadIdsOf(picks);
  const [first, setFirst] = useState(leadsNow);
  const rows = teamRowsOf(picks, shown, noTeamId, first);
  // A small company opens every team; a large one opens a team on its press. A search opens all it found.
  const openFirst = picks.people.length <= openUpTo || rows.length === 1;
  const isOpen = (id: string) =>
    searching || opened.has(id) || (openFirst && !closed.has(id));
  const taking = shown.filter((person) => takesPart(picks, person)).length;
  const { taking: allTaking, leads: allLeads, all } = countsOf(picks);
  const summary = searching
    ? plural(shown.length, {
        0: "Nobody found by that name",
        one: "# person found",
        other: "# people found",
      })
    : `${t`${allTaking} of ${all} taking part`} · ${plural(allLeads, {
        one: "# lead",
        other: "# leads",
      })}`;
  return (
    <Card padding="none">
      {/* One child: the card parts its children by a few pixels, which showed as a strip over the first team. */}
      <div>
        <div {...stylex.props(styles.toolbar)}>
          <InputGroup>
            <InputGroupAddon>
              <Icon icon={SearchIcon} />
            </InputGroupAddon>
            <InputGroupInput
              aria-label={t`Search people`}
              onValueChange={setQuery}
              placeholder={t`Search by name, email or team`}
              type="search"
              value={query}
            />
            <InputGroupClear aria-label={t`Clear the search`} />
          </InputGroup>
          <div {...stylex.props(styles.all)}>
            <Checkbox
              aria-label={searching ? t`Everyone found` : t`Everyone`}
              checked={checkedOf(taking, shown.length)}
              disabled={shown.length === 0}
              onCheckedChange={(on) => {
                onPicks(
                  withTaking(
                    picks,
                    new Set(shown.map(({ id }) => id)),
                    on === true
                  )
                );
              }}
            />
            <Text as="span" color="muted" size="sm">
              {summary}
            </Text>
          </div>
        </div>
        <ul aria-label={t`People`} {...stylex.props(styles.list)}>
          {rows.map(({ team, people }) => (
            <TeamRow
              key={team.id}
              onOpen={(open) => {
                const without = (set: ReadonlySet<string>) =>
                  new Set([...set].filter((id) => id !== team.id));
                setFirst(leadsNow());
                setOpened(
                  open ? new Set([...opened, team.id]) : without(opened)
                );
                setClosed(
                  open ? without(closed) : new Set([...closed, team.id])
                );
              }}
              onPicks={onPicks}
              open={isOpen(team.id)}
              people={people}
              picks={picks}
              searching={searching}
              team={team.id === noTeamId ? { ...team, name: noTeam } : team}
            />
          ))}
        </ul>
      </div>
    </Card>
  );
};

/** Nobody yet: no directory, and no list. The ways to add them stand in the middle. */
const NobodyYet = ({ onAdd }: { onAdd: () => void }) => {
  const { t } = useLingui();
  return (
    <Card padding="lg">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t`Nobody on the list yet`}</EmptyTitle>
          <EmptyDescription>
            {t`Add people by email address, or share a staff list.`}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={onAdd} variant="outline">
            <Icon icon={UserPlusIcon} />
            {t`Add people`}
          </Button>
        </EmptyContent>
      </Empty>
    </Card>
  );
};

/** What the step says, and what Stephen says as it arrives, by where the people came from. */
const useWords = (from: "directory" | "list" | "nobody", signIn: string) => {
  const { t } = useLingui();
  if (from === "nobody") {
    return {
      title: t`Who should I talk to?`,
      body: t`Add the people I’ll talk to, by email or with a staff list. Then mark who leads each team: I talk to the leads first.`,
      spoken: t`Now for the people I’ll be talking to. I don’t have anyone yet, so add them here by email, or drop in a staff list if you have one. Then mark who leads each team. I always start with the leads, so they hear about this before their team does.`,
    };
  }
  return {
    title: t`Who should I talk to?`,
    body:
      from === "directory"
        ? t`Everyone from ${signIn} is listed below. Untick anyone who isn’t taking part, and mark each team’s leads—I’ll talk to them first.`
        : t`Everyone from your staff list is here. Untick who isn’t taking part, and mark who leads each team: I talk to the leads first.`,
    spoken:
      from === "directory"
        ? t`Now let’s decide who I’ll be talking to. Everyone from ${signIn} is already here—just untick anyone who shouldn’t be included, and mark each team’s leads, as many as it has. I always speak with leads first so they know what’s coming before their team does. Missing someone? Add them by email.`
        : t`Now for the people I’ll be talking to. Everyone from your staff list is already here. Untick anyone who shouldn’t take part, and mark who leads each team. I always start with the leads, so they hear about this before their team does. Someone missing? Add them by email.`,
  };
};

/** What Stephen says of who he'll talk to, as the next step arrives. */
const leadsLeft = {
  leads: msg`Good, I’ll start with the leads you selected.`,
  people: msg`Got it, now I know who I’ll talk to.`,
  nobody: msg`Nobody on the list yet, that’s fine. We’ll add them together later.`,
};

/** What Stephen answers as the list changes: a lead marked, someone left out, people added, a list shared. */
const peopleAnswers = {
  lead: msg`Got it, I’ll start with them.`,
  out: msg`Understood, I’ll leave them out.`,
  added: msg`Got it, they’ve been added.`,
  list: msg`Got the list—everyone’s in.`,
};

export const LeadsStep = ({ data, onward }: StepProps) => {
  const { t } = useLingui();
  const { run, busy, failure } = useCoreAction();
  const refresh = useRefresh();
  const { roster, waiting } = data.view;
  const from = JSON.stringify(roster);
  // Changed and not confirmed yet, it is as they left it.
  const [picks, setPicks] = useState<Picks>(
    () => orgDraft.of(from) ?? roster ?? noPicks
  );
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const noTeam = t({
    message: "Other",
    context: "the team for people a staff list gives no team",
  });
  const directory =
    data.directory?.status === "active" ? data.directory.suite : null;
  let source: "directory" | "list" | "nobody" = "directory";
  if (roster === null) {
    source = "nobody";
  } else if (directory === null) {
    source = "list";
  }
  // By what core has, not by what the admin changes here: Stephen says the step once, as it arrives.
  const words = useWords(
    source,
    directory === null ? "" : suiteNames[directory]
  );
  const change = (next: Picks) => {
    setProblem(null);
    if (next.people.length > 0) {
      orgDraft.keep(from, next);
    }
    setPicks(next);
  };
  const { taking, leads: marked } = countsOf(picks);
  const answer = useAnswer(Object.values(peopleAnswers));
  // A lead marked, or someone left out, as they do it in the list.
  const pick = (next: Picks) => {
    const now = countsOf(next);
    if (now.leads > marked) {
      answer(peopleAnswers.lead);
    } else if (now.taking < taking) {
      answer(peopleAnswers.out);
    }
    change(next);
  };
  let left = leadsLeft.people;
  if (picks.people.length === 0) {
    left = leadsLeft.nobody;
  } else if (marked > 0) {
    left = leadsLeft.leads;
  }
  useLeaving(left);
  const confirm = async () => {
    if (busy || refreshing) {
      return;
    }
    if (taking === 0) {
      setProblem(
        t`Tick at least one person to take part, or skip this for now.`
      );
      return;
    }
    // Confirmed as it stands before, on this page: nothing to send again.
    if (JSON.stringify(picks) === from && orgConfirmed.of(from) === true) {
      await onward();
      return;
    }
    const kept = await run(
      async (session) => await session.onboarding.confirmRoster(picks)
    );
    if (kept !== undefined) {
      orgConfirmed.keep(JSON.stringify(kept.roster), true);
      setRefreshing(true);
      await refresh();
      setRefreshing(false);
      await onward();
    }
  };
  const nobody = picks.people.length === 0;
  return (
    <CalmStep
      also={
        <ForgetTeams onErased={refresh} teamsInBrain={data.view.teamsInBrain} />
      }
      body={words.body}
      end={
        nobody ? (
          <Button
            onClick={() => {
              void onward();
            }}
            size="lg"
            variant="outline"
          >
            {t`Skip for now`}
          </Button>
        ) : (
          <>
            <Button
              onClick={() => {
                void confirm();
              }}
              size="lg"
              status={busy || refreshing ? "loading" : "idle"}
            >
              {t`Continue`}
            </Button>
            <Button
              onClick={() => {
                setAdding(true);
              }}
              size="lg"
              variant="outline"
            >
              {t`Add people`}
            </Button>
          </>
        )
      }
      spoken={words.spoken}
      title={words.title}
    >
      <div {...stylex.props(styles.stack)}>
        {nobody ? (
          <NobodyYet
            onAdd={() => {
              setAdding(true);
            }}
          />
        ) : (
          <PeopleList noTeam={noTeam} onPicks={pick} picks={picks} />
        )}
        <WaitingNote waiting={waiting} />
      </div>
      <PeopleAdd
        noTeam={noTeam}
        onAdd={(typed, to) => {
          try {
            change(withAdded(picks, typed, to).picks);
            answer(peopleAnswers.added);
            return true;
          } catch (error) {
            if (error instanceof TooManyPeopleError) {
              setProblem(t`That’s more people than I can take: up to 2,000.`);
              return false;
            }
            throw error;
          }
        }}
        onList={(next) => {
          change(next);
          answer(peopleAnswers.list);
        }}
        onOpenChange={setAdding}
        open={adding}
        picks={picks}
      />
      <TopError>{problem ?? failure}</TopError>
    </CalmStep>
  );
};
