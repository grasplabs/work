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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Trans, useLingui } from "@lingui/react/macro";
import { FolderIcon, UserPlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { roleLabel } from "../labels.ts";
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
 * read: `onOpen` asks for it each time the list opens.
 */
export const SharePicker = ({
  offered,
  onOpen,
  onPick,
  disabled,
  roleHeading,
  roleName,
  empty,
  children,
}: {
  offered: ShareOffer | undefined;
  onOpen: () => void;
  onPick: (picked: Picked, role: ShareRole) => void;
  disabled: boolean;
  /** Over the role: "Share as". */
  roleHeading: ReactNode;
  /** The role's name for screen readers. */
  roleName: string;
  /** What the list says when nobody is left to offer. */
  empty: ReactNode;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<ShareRole>("user");
  const pick = (picked: Picked): void => {
    setOpen(false);
    onPick(picked, role);
  };
  const { people, teams, projects = [] } = offered ?? {};
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
        <UserPlusIcon data-icon="inline-start" />
        {children}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" variant="flush">
        <div className="flex items-center justify-between gap-2 border-b p-2">
          <span className="text-muted-foreground text-sm">{roleHeading}</span>
          <RoleSelect label={roleName} onChange={setRole} role={role} />
        </div>
        <Command filter={matchTyped}>
          <CommandInput placeholder={t`Search people and teams`} />
          <CommandList>
            {people === undefined || teams === undefined ? (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
                <Spinner />
                <Trans>Reading people and teams…</Trans>
              </div>
            ) : (
              <>
                <CommandEmpty>{empty}</CommandEmpty>
                {people.length === 0 ? null : (
                  <CommandGroup heading={t`People`}>
                    {people.map((person) => (
                      <PersonOption
                        key={person.id}
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
