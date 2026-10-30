import type { Member, OrganizationTeam } from "@grasp-os/shared/members";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Trans, useLingui } from "@lingui/react/macro";
import { UserMinusIcon } from "lucide-react";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { initials } from "../frame/person-menu.tsx";
import { addTeamMember, removeTeamMember } from "./team-changes.ts";
import { useTeamChange } from "./use-team-change.ts";

// Who is in a team, for admins: each of them, a way to take them off it,
// and a way to put any other member of the organization on it.

/** Someone in the team: a member, or only their ID if they aren't listed. */
interface InTeam {
  userId: string;
  name: string;
  email?: string;
}

/** The team's people by name, as the organization's members name them. */
const peopleIn = (
  team: OrganizationTeam,
  members: readonly Member[]
): InTeam[] => {
  const byId = new Map(members.map((member) => [member.userId, member]));
  return team.memberIds
    .map((userId) => byId.get(userId) ?? { userId, name: userId })
    .toSorted((a, b) => a.name.localeCompare(b.name));
};

/** The organization's members not in the team yet, by name. */
const othersOf = (
  team: OrganizationTeam,
  members: readonly Member[]
): { value: string; label: string }[] => {
  const inTeam = new Set(team.memberIds);
  return members
    .filter((member) => !inTeam.has(member.userId))
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((member) => ({
      value: member.userId,
      label: `${member.name} (${member.email})`,
    }));
};

export const TeamMembersDialog = ({
  team,
  members,
  open,
  onOpenChange,
  onChanged,
}: {
  team: OrganizationTeam;
  members: readonly Member[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const pickId = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const { busy, failure, run } = useTeamChange(onChanged);
  const { name } = team;
  const people = peopleIn(team, members);
  const others = othersOf(team, members);
  // One that was added since, or left the organization, is no longer offered.
  const picked = others.some((other) => other.value === chosen) ? chosen : null;
  const add = async (userId: string): Promise<void> => {
    const refused = await run(
      async () => {
        await addTeamMember(team.id, userId);
      },
      t`They couldn't be added to ${name}. Try again.`
    );
    if (refused === undefined) {
      setChosen(null);
    }
  };
  const remove = async (person: InTeam): Promise<void> => {
    const who = person.name;
    await run(
      async () => {
        await removeTeamMember(team.id, person.userId);
      },
      t`${who} couldn't be taken off ${name}. Try again.`
    );
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Members of {name}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              What is shared with {name} is shared with each of them.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        {others.length === 0 ? (
          <p className="text-muted-foreground">
            <Trans>Everyone in the organization is in this team.</Trans>
          </p>
        ) : (
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (picked !== null) {
                void add(picked);
              }
            }}
          >
            <Field className="min-w-0 flex-1">
              <FieldLabel htmlFor={pickId}>
                <Trans>Add a member</Trans>
              </FieldLabel>
              <Select
                items={others}
                onValueChange={(value: string | null) => {
                  setChosen(value);
                }}
                value={picked}
              >
                <SelectTrigger className="w-full" id={pickId}>
                  <SelectValue placeholder={t`Choose someone`} />
                </SelectTrigger>
                <SelectContent>
                  {others.map((other) => (
                    <SelectItem key={other.value} value={other.value}>
                      {other.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button disabled={busy || picked === null} type="submit">
              <Trans>Add</Trans>
            </Button>
          </form>
        )}
        <ErrorText>{failure}</ErrorText>
        {people.length === 0 ? (
          <p className="text-muted-foreground">
            <Trans>Nobody is in this team yet.</Trans>
          </p>
        ) : (
          <ul aria-label={t`Members of ${name}`} className="flex flex-col">
            {people.map((person) => {
              const who = person.name;
              return (
                <li
                  className="flex items-center gap-3 border-t py-2"
                  key={person.userId}
                >
                  <Avatar className="size-8">
                    <AvatarFallback>{initials(person.name)}</AvatarFallback>
                  </Avatar>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{person.name}</span>
                    {person.email === undefined ? null : (
                      <span className="text-muted-foreground truncate">
                        {person.email}
                      </span>
                    )}
                  </div>
                  <Button
                    aria-label={t`Take ${who} off ${name}`}
                    disabled={busy}
                    onClick={() => {
                      void remove(person);
                    }}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <UserMinusIcon />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
};
