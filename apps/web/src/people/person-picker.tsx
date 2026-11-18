import {
  Avatar as KitAvatar,
  AvatarFallback as KitAvatarFallback,
} from "@grasp-os/ui/components/avatar";
import { CommandItem } from "@grasp-os/ui/components/command";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { initials } from "../frame/person-menu.tsx";
import { Avatar, AvatarFallback } from "../grasp/avatar/index.ts";
import { Command } from "../grasp/command/index.ts";
import type { CommandEntry } from "../grasp/command/index.ts";
import { ChevronDown, Icon, Person } from "../grasp/icons/index.ts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../grasp/popover/index.ts";
import { usePeopleApart } from "./people-apart.ts";
import type { PeopleApart } from "./people-apart.ts";

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

/** Someone's portrait: their initials. */
export const PersonAvatar = ({ name }: { name: string }) => (
  <Avatar decorative name={name} size="xs">
    <AvatarFallback />
  </Avatar>
);

/**
 * One person in a list of people to pick from: their portrait and name,
 * found by either their name or their email as typed, and under it what
 * tells them apart from someone of the same name (`usePeopleApart`).
 *
 * Still the old kit's row: the sharing picker (`share-picker.tsx`) lists it
 * in its own old list until sharing moves onto the library, and this
 * pickers' lists are the library's Command (`personEntry`).
 */
export const PersonOption = ({
  person,
  checked = false,
  hint,
  onSelect,
}: {
  person: Pickable;
  checked?: boolean;
  /** What tells them apart from a namesake (`PeopleApart`'s `hint`). */
  hint?: string;
  onSelect: () => void;
}) => (
  <CommandItem
    data-checked={checked}
    onSelect={onSelect}
    keywords={[person.name, person.email ?? "", hint ?? ""]}
    // Their ID keeps two people of the same name apart.
    value={`person:${person.id}`}
  >
    <KitAvatar size="sm">
      <KitAvatarFallback>{initials(person.name)}</KitAvatarFallback>
    </KitAvatar>
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{person.name}</span>
      {hint === undefined ? null : (
        <span className="text-muted-foreground truncate text-xs">{hint}</span>
      )}
    </span>
  </CommandItem>
);

/**
 * One person in the library's list of people to pick from: their name,
 * found by their name, their email or what tells them apart from a
 * namesake (`usePeopleApart`), which stands under it. Their ID keeps two
 * people of the same name apart.
 */
export const personEntry = (
  person: Pickable,
  hint: string | undefined,
  value = `person:${person.id}`
): CommandEntry => ({
  value,
  label: person.name,
  icon: Person,
  keywords: [person.email ?? "", hint ?? ""],
  ...(hint === undefined ? {} : { description: hint }),
});

/** The entries whose words hold what was typed, as `matchTyped` finds them. */
export const entriesTyped = (
  entries: readonly CommandEntry[],
  query: string
): CommandEntry[] =>
  entries.filter(
    (entry) =>
      matchTyped(entry.label, query, [entry.label, ...(entry.keywords ?? [])]) >
      0
  );

/**
 * The owner as their button names them: told apart from a namesake once
 * the list is read and holds them.
 */
const ownerNamed = (
  name: string | null,
  id: string | null,
  people: readonly Pickable[] | null,
  apart: PeopleApart
): string | null => {
  const listed = people?.find((each) => each.id === id);
  return name === null || listed === undefined
    ? name
    : apart.named({ ...listed, name });
};

/** The owner's portrait on the button, or a quiet mark for nobody yet. */
const OwnerFace = ({ name }: { name: string | null }) =>
  name === null ? (
    <Avatar decorative name="?" size="xs">
      <AvatarFallback>?</AvatarFallback>
    </Avatar>
  ) : (
    <PersonAvatar name={name} />
  );

/** What the owner's button shows: their portrait, and their name and the chevron when there is room. */
const ownerButtonWords = (
  ownerName: string | null,
  owner: string,
  compact: boolean,
  disabled: boolean
) => {
  const face = <OwnerFace key="face" name={ownerName} />;
  if (compact) {
    return face;
  }
  return disabled
    ? [face, owner]
    : [face, owner, <Icon icon={ChevronDown} key="chevron" />];
};

/**
 * The owner's button and its list. `people` is null while they're being
 * read: the list says so, and the page reads them only when it opens.
 */
export const PersonPicker = ({
  owner: ownerName,
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
  const [query, setQuery] = useState("");
  const apart = usePeopleApart(people ?? []);
  const owner = ownerNamed(ownerName, ownerId, people, apart);
  const shown = owner ?? t`No owner yet`;
  const label =
    owner === null
      ? t`Owner: nobody yet. Change owner`
      : t`Owner: ${owner}. Change owner`;
  const entries = (people ?? []).map((person) => ({
    ...personEntry(person, apart.hint(person)),
    current: person.id === ownerId,
  }));
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
        aria-label={disabled ? shown : label}
        disabled={disabled}
        size="sm"
        tooltip={compact ? shown : undefined}
        variant="ghost"
      >
        {ownerButtonWords(ownerName, shown, compact, disabled)}
      </PopoverTrigger>
      <PopoverContent align={align}>
        <Command
          aria-label={t`Search people`}
          bare
          empty={t`Nobody with that name.`}
          filter={false}
          items={entriesTyped(entries, query)}
          loading={people === null}
          loadingLabel={t`Reading who can own it…`}
          onAction={(value) => {
            setOpen(false);
            const person = people?.find(
              (each) => `person:${each.id}` === value
            );
            if (person !== undefined && person.id !== ownerId) {
              onPick(person);
            }
          }}
          onQueryChange={setQuery}
          placeholder={t`Search people`}
          query={query}
        />
      </PopoverContent>
    </Popover>
  );
};
