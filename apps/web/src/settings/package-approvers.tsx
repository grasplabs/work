import type {
  DependencyApprover,
  DependencyApproverSubject,
} from "@grasp-os/shared/dependencies";
import { Badge } from "@grasp-os/ui/components/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { PlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { PersonOption } from "../people/person-picker.tsx";
import type { Pickable } from "../people/person-picker.tsx";
import { useCoreAction } from "../use-core-action.ts";
import type { TeamChoice } from "../workflows/team-picker.tsx";
import { SettingsSection } from "./settings-parts.tsx";

// Settings › Packages › Who approves packages (GRA-1300): the members and
// teams an admin gave `dependencies.approve`, the one permission that
// decides an App's or a workflow's npm packages. No role includes it, an
// admin's neither, so until someone is given it here every package
// request waits. Admins see who holds it and give or take it away; Grasp
// staff only see. Core checks all of it on every call (that the caller is
// still an admin, never staff; that the member or team is there) and
// records each grant and revoke in the audit log; the page only offers.

/** Who can be given the permission: the organization's people and teams. */
interface Candidates {
  people: Pickable[];
  teams: TeamChoice[];
}

/** The key of a member or team, the same for a grant and a candidate. */
const keyOf = (subject: DependencyApproverSubject): string =>
  subject.type === "person"
    ? `person:${subject.userId}`
    : `team:${subject.teamId}`;

/**
 * The button that gives the permission, and its list of the people and
 * teams who don't hold it yet. `candidates` is null while they're read.
 */
const GrantPicker = ({
  candidates,
  holding,
  disabled,
  onOpen,
  onPick,
}: {
  candidates: Candidates | null;
  /** The keys of everyone who holds it now, left out of the list. */
  holding: ReadonlySet<string>;
  disabled: boolean;
  onOpen: () => void;
  onPick: (subject: DependencyApproverSubject) => void;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const people =
    candidates?.people.filter(
      ({ id }) => !holding.has(keyOf({ type: "person", userId: id }))
    ) ?? [];
  const teams =
    candidates?.teams.filter(
      ({ id }) => !holding.has(keyOf({ type: "team", teamId: id }))
    ) ?? [];
  const pick = (subject: DependencyApproverSubject): void => {
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
        <Trans>Add approver</Trans>
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
                          pick({ type: "person", userId: person.id });
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
                          pick({ type: "team", teamId: team.id });
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

/** Who approves packages, for an admin; `editable` for one who isn't Grasp staff. */
export const PackageApprovers = ({
  approvers,
  editable,
}: {
  /** Every grant core returned, revoked ones included. */
  approvers: readonly DependencyApprover[];
  editable: boolean;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [candidates, setCandidates] = useState<Candidates | null>(null);
  const active = approvers.filter(({ status }) => status === "active");
  const holding = new Set(active.map(({ subject }) => keyOf(subject)));
  const readCandidates = async (): Promise<void> => {
    if (candidates !== null) {
      return;
    }
    const read = await run(async (session) => {
      const [members, teams] = await Promise.all([
        session.members.list(),
        session.workflows.teams(),
      ]);
      return { members, teams };
    });
    if (read !== undefined) {
      setCandidates({
        people: read.members
          .map(({ userId, name, email }) => ({ id: userId, name, email }))
          .toSorted((a, b) => a.name.localeCompare(b.name)),
        teams: read.teams.toSorted((a, b) => a.name.localeCompare(b.name)),
      });
    }
  };
  const refresh = async (): Promise<void> => {
    await router.invalidate({ sync: true });
  };
  const grant = async (subject: DependencyApproverSubject): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => await session.dependencies.grantApprover(subject),
        refresh
      );
    });
  };
  const revoke = async (id: string): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => await session.dependencies.revokeApprover(id),
        refresh
      );
    });
  };
  return (
    <SettingsSection
      action={
        editable ? (
          <GrantPicker
            candidates={candidates}
            disabled={busy}
            holding={holding}
            onOpen={() => {
              void readCandidates();
            }}
            onPick={(subject) => {
              void grant(subject);
            }}
          />
        ) : undefined
      }
      description={
        <Trans>
          The people and teams who approve or deny the npm packages domains and
          workflows ask for. No role includes this, not even admin: add yourself
          to approve packages.
        </Trans>
      }
      title={t`Who approves packages`}
    >
      {failure === undefined ? null : (
        <div className="border-t px-5 py-3">
          <ErrorText>{failure}</ErrorText>
        </div>
      )}
      {active.length === 0 ? (
        <p className="text-muted-foreground border-t px-5 py-4">
          <Trans>
            Nobody approves packages yet, so every package request waits.
          </Trans>
        </p>
      ) : (
        <div className="border-t">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <Trans>Name</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Kind</Trans>
                </TableHead>
                <TableHead>
                  <Trans>Added</Trans>
                </TableHead>
                {editable ? (
                  <TableHead>
                    <span className="sr-only">
                      <Trans>Actions</Trans>
                    </span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {active.map(({ id, subject, name, grantedAt }) => {
                const named = name ?? t`Removed`;
                return (
                  <TableRow key={id}>
                    <TableCell>{named}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {subject.type === "team" ? t`Team` : t`Person`}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <time dateTime={grantedAt}>
                        {formatDateTime(grantedAt)}
                      </time>
                    </TableCell>
                    {editable ? (
                      <TableCell className="text-right">
                        <Button
                          aria-label={t`Remove ${named} as an approver`}
                          disabled={busy}
                          onClick={() => {
                            void revoke(id);
                          }}
                          size="sm"
                          variant="ghost"
                        >
                          <Trans>Remove</Trans>
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </SettingsSection>
  );
};
