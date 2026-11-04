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
import { PlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import type { Session } from "../core.ts";
import type { TeamChoice } from "../workflows/team-picker.tsx";
import { PersonOption } from "./person-picker.tsx";
import type { Pickable } from "./person-picker.tsx";

// The organization's people and teams to add one of to a list: who
// approves packages, who answers a workflow's decision. One button that
// opens a list to search, people and teams apart, leaving out those the
// list holds already. Who may be added is core's to decide; the list is
// whoever the page offers.

/** Who can be added: the organization's people and teams. */
export interface PeopleAndTeams {
  people: Pickable[];
  teams: TeamChoice[];
}

/** One person or team picked, by the key a list holds it under. */
export interface PickedSubject {
  type: "person" | "team";
  id: string;
  name: string;
}

/** The key a person or team is held under: `person:<id>` or `team:<id>`. */
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
 * The button that adds someone, and its list of the people and teams not
 * held yet. `candidates` is null while they're read.
 */
export const PeopleTeamsPicker = ({
  label,
  candidates,
  holding,
  disabled,
  onOpen,
  onPick,
}: {
  label: ReactNode;
  candidates: PeopleAndTeams | null;
  /** The keys of everyone held now (`subjectKey`), left out of the list. */
  holding: ReadonlySet<string>;
  disabled: boolean;
  onOpen: () => void;
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
  const pick = (subject: PickedSubject): void => {
    setOpen(false);
    onPick(subject);
  };
  return (
    <Popover
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (next) {
          onOpen();
        }
      }}
      open={open}
    >
      <PopoverTrigger
        disabled={disabled}
        render={<Button size="sm" variant="outline" />}
      >
        <PlusIcon />
        {label}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72" variant="flush">
        {/* Names match as typed, not letter by letter, as in the owner picker. */}
        <Command
          filter={(value: string, search: string) =>
            value.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput placeholder={t`Search people and teams`} />
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
                        onSelect={() => {
                          pick({
                            type: "person",
                            id: person.id,
                            name: person.name,
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
                        // A team's ID keeps it apart from a person of the same name.
                        value={`${team.name} ${team.id}`}
                      >
                        <UsersIcon className="text-muted-foreground" />
                        <span className="flex-1 truncate">{team.name}</span>
                      </CommandItem>
                    ))}
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
