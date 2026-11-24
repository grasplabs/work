import { Button } from "@grasp-os/app-kit/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@grasp-os/app-kit/components/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@grasp-os/app-kit/components/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/app-kit/components/select";
import { Spinner } from "@grasp-os/app-kit/components/spinner";
import { Trans, useLingui } from "@lingui/react/macro";
import { FolderIcon, MailIcon, UserPlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";

import { ErrorText } from "../error-text.tsx";
import { roleLabel } from "../labels.ts";
import type { PeopleApart } from "./people-apart.ts";
import { matchTyped, PersonOption } from "./person-picker.tsx";
import type { Pickable } from "./person-picker.tsx";

// Giving people and teams a role in something (an App, a project): one
// button that opens a list to search, with the role to give over it. An
// App also offers its builder's projects, whose everyone it reaches. Who
// is offered is the page's to say, read when the list first opens.

/** A role in an App or a project. */
export type ShareRole = "user" | "builder";

const roles: readonly ShareRole[] = ["user", "builder"];

/** Whom to offer: people, teams and, for an App, projects. */
export interface ShareOffer {
  people: readonly Pickable[];
  teams: readonly { id: string; name: string }[];
  projects?: readonly { id: string; name: string }[];
}

/** An address as core takes a guest's (guest-members.ts). */
const addressSchema = z.email().max(254);

/**
 * What was typed, as an address to invite: when it is one, and nobody
 * offered goes by it (a guest is offered by their address).
 */
const addressToInvite = (
  typed: string,
  people: readonly Pickable[]
): string | undefined => {
  const parsed = addressSchema.safeParse(typed.trim().toLowerCase());
  if (!parsed.success) {
    return undefined;
  }
  const address = parsed.data;
  return people.some(
    ({ name, email }) =>
      name.toLowerCase() === address || email?.toLowerCase() === address
  )
    ? undefined
    : address;
};

/** Who was picked. */
export interface Picked {
  type: "person" | "team" | "project";
  id: string;
}

/** A role to choose, labelled in the page's language. */
export const RoleSelect = ({
  role,
  label,
  disabled,
  onChange,
}: {
  role: ShareRole;
  label: string;
  disabled?: boolean;
  onChange: (role: ShareRole) => void;
}) => {
  const items = roles.map((each) => ({ value: each, label: roleLabel(each) }));
  return (
    <Select
      disabled={disabled}
      items={items}
      onValueChange={(value: string | null) => {
        const chosen = roles.find((each) => each === value);
        if (chosen !== undefined && chosen !== role) {
          onChange(chosen);
        }
      }}
      value={role}
    >
      <SelectTrigger aria-label={label} size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

/**
 * The button (`children`) and its list. `offered` is undefined while it is
 * read: `onOpen` asks for it each time the list opens, and `failure`
 * says why a read didn't come.
 */
export const SharePicker = ({
  offered,
  onOpen,
  onPick,
  disabled,
  failure,
  roleHeading,
  roleName,
  empty,
  hintOf,
  onInvite,
  children,
}: {
  offered: ShareOffer | undefined;
  onOpen: () => void;
  onPick: (picked: Picked, role: ShareRole) => void;
  disabled: boolean;
  failure: string | undefined;
  /** Over the role: "Share as". */
  roleHeading: ReactNode;
  /** The role's name for screen readers. */
  roleName: string;
  /** What the list says when nobody is left to offer. */
  empty: ReactNode;
  /**
   * What tells someone apart from a namesake (`usePeopleApart`), among
   * everyone the page knows: those offered and those who have a role.
   */
  hintOf: PeopleApart["hint"];
  /**
   * Invites a typed address that belongs to nobody offered as a guest,
   * who only ever uses it: an App's alone. Core says whether it may.
   */
  onInvite?: (address: string) => void;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<ShareRole>("user");
  const [typed, setTyped] = useState("");
  const pick = (picked: Picked): void => {
    setOpen(false);
    onPick(picked, role);
  };
  const { people, teams, projects = [] } = offered ?? {};
  const address =
    onInvite === undefined || people === undefined
      ? undefined
      : addressToInvite(typed, people);
  return (
    <Popover
      onOpenChange={(next: boolean) => {
        setOpen(next);
        setTyped("");
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
        <UserPlusIcon data-icon="inline-start" />
        {children}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" variant="flush">
        <div className="flex items-center justify-between gap-2 border-b p-2">
          <span className="text-muted-foreground text-sm">{roleHeading}</span>
          <RoleSelect label={roleName} onChange={setRole} role={role} />
        </div>
        <Command filter={matchTyped}>
          <CommandInput
            onValueChange={setTyped}
            placeholder={
              onInvite === undefined
                ? t`Search people and teams`
                : t`Search people and teams, or type an email address`
            }
            value={typed}
          />
          <CommandList>
            {people === undefined || teams === undefined ? (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
                {failure === undefined ? (
                  <>
                    <Spinner />
                    <Trans>Reading people and teams…</Trans>
                  </>
                ) : (
                  <ErrorText>{failure}</ErrorText>
                )}
              </div>
            ) : (
              <>
                <CommandEmpty>{empty}</CommandEmpty>
                {address === undefined || onInvite === undefined ? null : (
                  <CommandGroup heading={t`Someone new`}>
                    <CommandItem
                      keywords={[address]}
                      onSelect={() => {
                        setOpen(false);
                        onInvite(address);
                      }}
                      value={`invite:${address}`}
                    >
                      <MailIcon className="text-muted-foreground" />
                      <span className="flex-1 truncate">
                        <Trans>Invite {address} as a guest</Trans>
                      </span>
                    </CommandItem>
                  </CommandGroup>
                )}
                {people.length === 0 ? null : (
                  <CommandGroup heading={t`People`}>
                    {people.map((person) => (
                      <PersonOption
                        key={person.id}
                        hint={hintOf(person)}
                        onSelect={() => {
                          pick({ type: "person", id: person.id });
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
                          pick({ type: "team", id: team.id });
                        }}
                        keywords={[team.name]}
                        value={`team:${team.id}`}
                      >
                        <UsersIcon className="text-muted-foreground" />
                        <span className="flex-1 truncate">{team.name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {projects.length === 0 ? null : (
                  <CommandGroup heading={t`Projects`}>
                    {projects.map((each) => {
                      const project = each.name;
                      return (
                        <CommandItem
                          key={each.id}
                          onSelect={() => {
                            pick({ type: "project", id: each.id });
                          }}
                          keywords={[project]}
                          value={`project:${each.id}`}
                        >
                          <FolderIcon className="text-muted-foreground" />
                          <span className="flex-1 truncate">
                            {t`Everyone in ${project}`}
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
