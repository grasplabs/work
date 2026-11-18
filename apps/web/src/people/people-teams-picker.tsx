import { roleSchema } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import type { ReactNode } from "react";

import type { Session } from "../core.ts";
import type { CommandEntry, CommandItems } from "../grasp/command/index.ts";
import { Command } from "../grasp/command/index.ts";
import { People, Plus, Tag } from "../grasp/icons/index.ts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../grasp/popover/index.ts";
import { roleLabel } from "../labels.ts";
import { usePeopleApart } from "./people-apart.ts";
import type { PeopleApart } from "./people-apart.ts";
import { entriesTyped, personEntry } from "./person-picker.tsx";
import type { Pickable } from "./person-picker.tsx";

// The organization's people and teams to pick one of: who approves
// packages, who answers a workflow's decision, whom a workflow's start
// names. One button that opens a list to search, people and teams apart,
// and the roles too where what is picked may name one (a decision's
// deciders, a workflow's person), leaving out those the list holds
// already. Who may be picked is core's to decide; the list is whoever the
// page offers.

/** Who can be added: the organization's people and teams. */
export interface PeopleAndTeams {
  people: Pickable[];
  teams: { id: string; name: string }[];
}

/** One person, team or role picked, by the key a list holds it under. */
export interface PickedSubject {
  type: "person" | "team" | "role";
  id: string;
  /** As the list named them: a person told apart from a namesake. */
  name: string;
}

/**
 * The key a person, team or role is held under: `person:<id>`,
 * `team:<id>` or `role:<role>`, as a decision names its deciders.
 */
export const subjectKey = ({ type, id }: Pick<PickedSubject, "type" | "id">) =>
  `${type}:${id}`;

/** The organization's members and teams, each by name. */
export const readPeopleAndTeams = async (
  session: Session
): Promise<PeopleAndTeams> => {
  const [members, teams] = await Promise.all([
    session.members.list(),
    session.organization.teams(),
  ]);
  return {
    people: members
      .map(({ userId, name, email }) => ({ id: userId, name, email }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
    teams: teams.toSorted((a, b) => a.name.localeCompare(b.name)),
  };
};

/**
 * Whom `key` (`subjectKey`) names, by name: a person among `candidates`,
 * told apart from a namesake by `apart`, a team among them, a role by its
 * label; undefined for one not known.
 */
export const subjectNamed = (
  key: string,
  candidates: PeopleAndTeams | null,
  apart: PeopleApart
): string | undefined => {
  const colon = key.indexOf(":");
  const type = key.slice(0, colon);
  const id = key.slice(colon + 1);
  if (type === "role") {
    return roleLabel(id);
  }
  if (type === "person") {
    const person = candidates?.people.find((each) => each.id === id);
    return person === undefined ? undefined : apart.named(person);
  }
  return candidates?.teams.find((each) => each.id === id)?.name;
};

/** A named group of the list, left out while nothing in it is offered. */
const groupOf = (label: string, items: CommandEntry[]): CommandItems =>
  items.length === 0 ? [] : [{ type: "group", label, items }];

/**
 * The button that picks someone, and its list of the people and teams
 * (and, with `roles`, the roles) not held yet. `candidates` is null while
 * they're read.
 */
export const PeopleTeamsPicker = ({
  buttonId,
  label,
  candidates,
  holding,
  disabled,
  roles = false,
  onOpen,
  onPick,
}: {
  /** The button's ID, for a form's label. */
  buttonId?: string;
  label: ReactNode;
  candidates: PeopleAndTeams | null;
  /** The keys of everyone held now (`subjectKey`), left out of the list. */
  holding: ReadonlySet<string>;
  disabled: boolean;
  /** Offer the organization's roles too: everyone who has one. */
  roles?: boolean;
  /** When the list opens: the moment to read the candidates, if the page reads them then. */
  onOpen?: () => void;
  onPick: (subject: PickedSubject) => void;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const people =
    candidates?.people.filter(
      ({ id }) => !holding.has(subjectKey({ type: "person", id }))
    ) ?? [];
  const teams =
    candidates?.teams.filter(
      ({ id }) => !holding.has(subjectKey({ type: "team", id }))
    ) ?? [];
  // Told apart from a namesake already held too.
  const apart = usePeopleApart(candidates?.people ?? []);
  const offeredRoles = roles
    ? roleSchema.options.filter(
        (role) => !holding.has(subjectKey({ type: "role", id: role }))
      )
    : [];
  // Each one offered, by the key it is held under, to pick it by.
  const offered = new Map<string, PickedSubject>([
    ...people.map((person): [string, PickedSubject] => [
      subjectKey({ type: "person", id: person.id }),
      { type: "person", id: person.id, name: apart.named(person) },
    ]),
    ...teams.map((team): [string, PickedSubject] => [
      subjectKey({ type: "team", id: team.id }),
      { type: "team", id: team.id, name: team.name },
    ]),
    ...offeredRoles.map((role): [string, PickedSubject] => [
      subjectKey({ type: "role", id: role }),
      { type: "role", id: role, name: roleLabel(role) },
    ]),
  ]);
  const items: CommandItems = [
    ...groupOf(
      t`People`,
      entriesTyped(
        people.map((person) => personEntry(person, apart.hint(person))),
        query
      )
    ),
    ...groupOf(
      t`Teams`,
      entriesTyped(
        teams.map((team) => ({
          value: subjectKey({ type: "team", id: team.id }),
          label: team.name,
          icon: People,
        })),
        query
      )
    ),
    ...groupOf(
      t`Roles`,
      entriesTyped(
        offeredRoles.map((role) => {
          const name = roleLabel(role);
          return {
            value: subjectKey({ type: "role", id: role }),
            label: t`Everyone with the ${name} role`,
            icon: Tag,
            keywords: [name],
          };
        }),
        query
      )
    ),
  ];
  const search = roles
    ? t`Search people, teams and roles`
    : t`Search people and teams`;
  return (
    <Popover
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (next) {
          setQuery("");
          onOpen?.();
        }
      }}
      open={open}
    >
      <PopoverTrigger
        disabled={disabled}
        icon={Plus}
        id={buttonId}
        size="sm"
        variant="quiet"
      >
        <span>{label}</span>
      </PopoverTrigger>
      <PopoverContent align="end">
        <Command
          aria-label={search}
          bare
          empty={t`Nobody else to add.`}
          filter={false}
          items={items}
          loading={candidates === null}
          loadingLabel={t`Reading people and teams…`}
          onAction={(value) => {
            setOpen(false);
            const subject = offered.get(value);
            if (subject !== undefined) {
              onPick(subject);
            }
          }}
          onQueryChange={setQuery}
          placeholder={search}
          query={query}
        />
      </PopoverContent>
    </Popover>
  );
};
