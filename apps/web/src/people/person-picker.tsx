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

import { OwnerAvatar } from "../landscape/owner.tsx";

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
 * One person in a list of people to pick from: their portrait and name,
 * found by either their name or their email as typed.
 */
export const PersonOption = ({
  person,
  checked = false,
  onSelect,
}: {
  person: Pickable;
  checked?: boolean;
  onSelect: () => void;
}) => (
  <CommandItem
    data-checked={checked}
    onSelect={onSelect}
    value={`${person.name} ${person.email ?? ""}`}
  >
    <OwnerAvatar name={person.name} />
    <span className="flex-1 truncate">{person.name}</span>
  </CommandItem>
);

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
          <OwnerAvatar name={owner} />
        )}
        {compact ? null : (owner ?? t`No owner yet`)}
        {compact || disabled ? null : (
          <ChevronDownIcon className="text-muted-foreground" />
        )}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-72" variant="flush">
        {/* Names match as typed, not letter by letter: "Eva" never finds "Wouter van den Berg". */}
        <Command
          filter={(value: string, search: string) =>
            value.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0
          }
        >
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
