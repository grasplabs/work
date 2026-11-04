import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Button } from "@grasp-os/ui/components/button";
import {
  Command,
  CommandEmpty,
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
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { initials } from "../frame/person-menu.tsx";

// Who owns a thing, and the people it can be handed to, as the prototype
// draws it (`components/owner-picker.tsx`): the owner's portrait, and
// their name when there is room, as one button that opens a list to
// search. The platform's one owner control: a workflow's line uses it, and
// an App's settings are to, so an owner looks and is changed the same way
// everywhere. Who may be picked is core's to decide; the list is whoever
// the page offers.

/** Someone who can be picked. */
export interface Pickable {
  id: string;
  name: string;
  email?: string;
}

/**
 * A list's filter: what was typed, found as typed in an option's words
 * (its `keywords`, else its value), never letter by letter: "Eva" never
 * finds "Wouter van den Berg".
 */
export const matchTyped = (
  value: string,
  search: string,
  keywords?: string[]
): number =>
  (keywords === undefined || keywords.length === 0 ? value : keywords.join(" "))
    .toLowerCase()
    .includes(search.trim().toLowerCase())
    ? 1
    : 0;

/** How many of the end of an ID a namesake is told apart by. */
const idHintLength = 6;

/** A name as `namesakesOf` compares it. */
export const nameKey = (name: string): string =>
  name.trim().toLocaleLowerCase();

/**
 * The names more than one of `people` go by, compared as written apart
 * from case and spacing: whom a list must tell apart (`PersonOption`'s
 * `namesake`).
 */
export const namesakesOf = (
  people: readonly Pickable[]
): ReadonlySet<string> => {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const { name } of people) {
    const key = nameKey(name);
    if (seen.has(key)) {
      shared.add(key);
    }
    seen.add(key);
  }
  return shared;
};

/** Someone's portrait: their initials. */
const PersonAvatar = ({ name }: { name: string }) => (
  <Avatar size="sm">
    <AvatarFallback>{initials(name)}</AvatarFallback>
  </Avatar>
);

/**
 * One person in a list of people to pick from: their portrait and name,
 * found by either their name or their email as typed. Someone whose name
 * another in the list shares (`namesake`) says, under it, who they are:
 * their email where the list has it, which only an admin's does, else
 * the end of their ID. Core tells a builder no more of a person than
 * their name and ID (app-members.ts, `shareCandidates`), and the ID is
 * what is shared, so that is what tells them apart: the same for that
 * person in every list, whoever else is in it.
 */
export const PersonOption = ({
  person,
  checked = false,
  namesake = false,
  onSelect,
}: {
  person: Pickable;
  checked?: boolean;
  /** Another in the list goes by the same name (`namesakesOf`). */
  namesake?: boolean;
  onSelect: () => void;
}) => {
  const { t } = useLingui();
  const end = person.id.slice(-idHintLength);
  const hint = namesake ? (person.email ?? t`ID …${end}`) : undefined;
  return (
    <CommandItem
      data-checked={checked}
      onSelect={onSelect}
      keywords={[person.name, person.email ?? "", hint ?? ""]}
      // Their ID keeps two people of the same name apart.
      value={`person:${person.id}`}
    >
      <PersonAvatar name={person.name} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{person.name}</span>
        {hint === undefined ? null : (
          <span className="text-muted-foreground truncate text-xs">{hint}</span>
        )}
      </span>
    </CommandItem>
  );
};

/**
 * The owner's button and its list. `people` is null while they're being
 * read: the list says so, and the page reads them only when it opens.
 */
export const PersonPicker = ({
  owner,
  ownerId,
  people,
  onOpen,
  onPick,
  compact = false,
  disabled = false,
  align = "end",
}: {
  /** The owner's name; null for nobody yet. */
  owner: string | null;
  /** The owner's ID, to tick them in the list. */
  ownerId: string | null;
  people: readonly Pickable[] | null;
  /** When the list opens: the moment to read who can be picked. */
  onOpen?: () => void;
  onPick: (person: Pickable) => void;
  /** Only the portrait, for a line of a list: the name is said when it is pointed at. */
  compact?: boolean;
  /** Shown, not to be changed: for someone who may only look. */
  disabled?: boolean;
  /** Which side of the button the list lines up with. */
  align?: "start" | "end";
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const namesakes = namesakesOf(people ?? []);
  const label =
    owner === null
      ? t`Owner: nobody yet. Change owner`
      : t`Owner: ${owner}. Change owner`;
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
        render={
          <Button
            aria-label={disabled ? (owner ?? t`No owner yet`) : label}
            size={compact ? "icon-sm" : "default"}
            title={compact ? (owner ?? t`No owner yet`) : undefined}
            variant="ghost"
          />
        }
      >
        {owner === null ? (
          <Avatar size="sm">
            <AvatarFallback>?</AvatarFallback>
          </Avatar>
        ) : (
          <PersonAvatar name={owner} />
        )}
        {compact ? null : (owner ?? t`No owner yet`)}
        {compact || disabled ? null : (
          <ChevronDownIcon className="text-muted-foreground" />
        )}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-72" variant="flush">
        <Command filter={matchTyped}>
          <CommandInput placeholder={t`Search people`} />
          <CommandList>
            {people === null ? (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
                <Spinner />
                <Trans>Reading who can own it…</Trans>
              </div>
            ) : (
              <>
                <CommandEmpty>
                  <Trans>Nobody with that name.</Trans>
                </CommandEmpty>
                {people.map((person) => (
                  <PersonOption
                    checked={person.id === ownerId}
                    key={person.id}
                    namesake={namesakes.has(nameKey(person.name))}
                    onSelect={() => {
                      setOpen(false);
                      if (person.id !== ownerId) {
                        onPick(person);
                      }
                    }}
                    person={person}
                  />
                ))}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
