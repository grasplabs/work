import { roleSchema } from "@grasp-os/shared/roles";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Button } from "@grasp-os/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandList,
} from "@grasp-os/ui/components/command";
import type { CommandItemData } from "@grasp-os/ui/components/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { Icon, KeyIcon, PlusIcon, UsersIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import type { Session } from "../core.ts";
import { roleLabel } from "../labels.ts";
import { usePeopleApart } from "./people-apart.ts";

// The organization's people, teams and roles to pick one of: who answers
// a workflow's decision, the roles too, as a decision sent to a role
// (`role:admin`) is answered only by a binding that names that role. One
// button that opens a list to search, people, teams and roles apart,
// leaving out those the list holds already. Who may
// be picked is core's to decide; the list is whoever the page offers. A
// workflow's start names one of the same subjects (`subjectKey`) through
// its own Combobox (start-run.tsx). Drawn as an App's "Add a connector"
// (apps/app-integrations.tsx): Damsko's Popover and Command.

/** Who can be added: the organization's people and teams. */
export interface PeopleAndTeams {
  people: { id: string; name: string; email?: string }[];
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
 * Whether `words` hold what was typed, as typed, never letter by letter:
 * "Eva" never finds "Wouter van den Berg". Damsko's Command filters
 * letter by letter only, so the list is filtered here.
 */
const holdsTyped = (words: readonly string[], typed: string): boolean =>
  words.join(" ").toLowerCase().includes(typed.trim().toLowerCase());

/** One subject the list offers: what it picks, and the words it is found by. */
interface Offer {
  subject: PickedSubject;
  words: string[];
  item: CommandItemData;
}

/**
 * The button that picks someone, and its list of the people, teams and
 * roles not held yet. `candidates` is null while they're read.
 */
export const PeopleTeamsPicker = ({
  label,
  candidates,
  holding,
  disabled,
  onOpen,
  onPick,
}: {
  label: string;
  candidates: PeopleAndTeams | null;
  /** The keys of everyone held now (`subjectKey`), left out of the list. */
  holding: ReadonlySet<string>;
  disabled: boolean;
  /** When the list opens: the moment to read the candidates, if the page reads them then. */
  onOpen?: () => void;
  onPick: (subject: PickedSubject) => void;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  // Told apart from a namesake already held too.
  const apart = usePeopleApart(candidates?.people ?? []);
  const offer = (
    subject: PickedSubject,
    words: string[],
    item: Omit<CommandItemData, "value">
  ): Offer => ({
    subject,
    words,
    item: { ...item, value: subjectKey(subject) },
  });
  const people = (candidates?.people ?? []).map((person) => {
    const hint = apart.hint(person);
    return offer(
      { type: "person", id: person.id, name: apart.named(person) },
      [person.name, person.email ?? "", hint ?? ""],
      {
        label: person.name,
        media: (
          <Avatar decorative name={person.name} size="xs">
            <AvatarFallback />
          </Avatar>
        ),
        ...(hint === undefined ? {} : { description: hint }),
      }
    );
  });
  const teams = (candidates?.teams ?? []).map((team) =>
    offer({ type: "team", id: team.id, name: team.name }, [team.name], {
      label: team.name,
      icon: UsersIcon,
    })
  );
  const roles =
    candidates === null
      ? []
      : roleSchema.options.map((role) => {
          const name = roleLabel(role);
          return offer({ type: "role", id: role, name }, [name], {
            label: t`Everyone with the ${name} role`,
            icon: KeyIcon,
          });
        });
  const shown = (offers: Offer[]): Offer[] =>
    offers.filter(
      ({ subject, words }) =>
        !holding.has(subjectKey(subject)) && holdsTyped(words, typed)
    );
  const groups = [
    { label: t`People`, offers: shown(people) },
    { label: t`Teams`, offers: shown(teams) },
    { label: t`Roles`, offers: shown(roles) },
  ].filter(({ offers }) => offers.length > 0);
  const byKey = new Map(
    groups.flatMap(({ offers }) =>
      offers.map(({ subject }) => [subjectKey(subject), subject] as const)
    )
  );
  const search = t`Search people, teams and roles`;
  return (
    <Popover
      onOpenChange={(next: boolean) => {
        setOpen(next);
        setTyped("");
        if (next) {
          onOpen?.();
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <Button disabled={disabled} size="sm" variant="outline">
          <Icon icon={PlusIcon} />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <Command
          filter={false}
          inputValue={typed}
          items={groups.map(({ label: heading, offers }) => ({
            type: "group" as const,
            label: heading,
            items: offers.map(({ item }) => item),
          }))}
          loading={candidates === null}
          onAction={(value) => {
            const subject = byKey.get(value);
            setOpen(false);
            if (subject !== undefined) {
              onPick(subject);
            }
          }}
          onInputValueChange={setTyped}
        >
          <CommandInput aria-label={search} placeholder={search} />
          <CommandEmpty>{t`Nobody else to add.`}</CommandEmpty>
          <CommandList />
        </Command>
      </PopoverContent>
    </Popover>
  );
};
