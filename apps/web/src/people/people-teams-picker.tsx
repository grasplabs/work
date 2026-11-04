import { roleSchema } from "@grasp-os/shared/roles";
import { Button } from "@grasp-os/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@grasp-os/ui/components/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon, IdCardIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import type { Session } from "../core.ts";
import { roleLabel } from "../labels.ts";
import type { TeamChoice } from "../workflows/team-picker.tsx";
import { usePeopleApart } from "./people-apart.ts";
import type { PeopleApart } from "./people-apart.ts";
import { matchTyped, PersonOption } from "./person-picker.tsx";
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
  teams: TeamChoice[];
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
    session.workflows.teams(),
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
  const pick = (subject: PickedSubject): void => {
    setOpen(false);
    onPick(subject);
  };
  return (
    <Popover
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (next) {
          onOpen?.();
        }
      }}
      open={open}
    >
      <PopoverTrigger
        disabled={disabled}
        id={buttonId}
        render={<Button size="sm" variant="outline" />}
      >
        <PlusIcon />
        {label}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72" variant="flush">
        <Command filter={matchTyped}>
          <CommandInput
            placeholder={
              roles
                ? t`Search people, teams and roles`
                : t`Search people and teams`
            }
          />
          <CommandList>
            {candidates === null ? (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
                <Spinner />
                <Trans>Reading people and teams…</Trans>
              </div>
            ) : (
              <>
                <CommandEmpty>
                  <Trans>Nobody else to add.</Trans>
                </CommandEmpty>
                {people.length === 0 ? null : (
                  <CommandGroup heading={t`People`}>
                    {people.map((person) => (
                      <PersonOption
                        key={person.id}
                        hint={apart.hint(person)}
                        onSelect={() => {
                          pick({
                            type: "person",
                            id: person.id,
                            name: apart.named(person),
                          });
                        }}
                        person={person}
                      />
                    ))}
                  </CommandGroup>
                )}
                {teams.length === 0 ? null : (
                  <CommandGroup heading={t`Teams`}>
                    {teams.map((team) => (
                      <CommandItem
                        key={team.id}
                        onSelect={() => {
                          pick({ type: "team", id: team.id, name: team.name });
                        }}
                        keywords={[team.name]}
                        value={subjectKey({ type: "team", id: team.id })}
                      >
                        <UsersIcon className="text-muted-foreground" />
                        <span className="flex-1 truncate">{team.name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {offeredRoles.length === 0 ? null : (
                  <CommandGroup heading={t`Roles`}>
                    {offeredRoles.map((role) => {
                      const name = roleLabel(role);
                      return (
                        <CommandItem
                          key={role}
                          onSelect={() => {
                            pick({ type: "role", id: role, name });
                          }}
                          keywords={[name]}
                          value={subjectKey({ type: "role", id: role })}
                        >
                          <IdCardIcon className="text-muted-foreground" />
                          <span className="flex-1 truncate">
                            {t`Everyone with the ${name} role`}
                          </span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
