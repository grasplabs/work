import type {
  App,
  AppMember,
  AppMemberRef,
  AppRole,
  ShareCandidates,
  ViewedApp,
} from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Trans, useLingui } from "@lingui/react/macro";
import { Await, useRouter } from "@tanstack/react-router";
import { UserPlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { roleLabel } from "../labels.ts";
import type { Loaded } from "../load-from-core.tsx";
import { PersonOption } from "../people/person-picker.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { buildsApp } from "./app-role.ts";

// Sharing an App (a domain's): whom it is open to besides its owner and
// the admins, as a user (its screens) or a builder (its code, settings and
// whom it is shared with), on its Members tab and from Share on its bar.
// Its builders share it, change a role and unshare it; everyone with a role
// in it sees whom it is shared with. Whom to share with comes from
// `apps.members.candidates`: the organization's people and teams by name,
// for whoever may share the App, since a builder isn't an admin and can't
// list the organization's members. Core checks every change (a builder of
// the App, not archived, never Grasp staff, and that everyone it would
// reach may read what the App has read) and records it in the audit log.

/** Whether `identity` may share `app`: a builder of it, while it isn't archived. */
export const sharesApp = (
  app: Pick<App, "status"> & { role: AppRole },
  identity: Pick<Identity, "staff">
): boolean => buildsApp(app, identity) && app.status !== "archived";

const roles: readonly AppRole[] = ["user", "builder"];

/** A role to choose, labelled in the page's language. */
const RoleSelect = ({
  role,
  label,
  disabled,
  onChange,
}: {
  role: AppRole;
  label: string;
  disabled?: boolean;
  onChange: (role: AppRole) => void;
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

/** Who `member` is, in words: a team says so. */
const memberName = (member: AppMember, team: (name: string) => string) => {
  const name = member.name ?? member.id;
  return member.type === "team" ? team(name) : name;
};

/**
 * Share: the organization's people and teams the App isn't shared with
 * yet, read when it opens, and the role to give whoever is picked.
 */
export const ShareApp = ({
  app,
  members,
}: {
  app: App;
  /** Whom it is shared with now, left out of the list; none while unknown. */
  members: readonly AppMemberRef[];
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<AppRole>("user");
  const [candidates, setCandidates] = useState<ShareCandidates | null>(null);
  const shared = new Set(members.map(({ type, id }) => `${type}:${id}`));
  const isOffered = (type: AppMemberRef["type"], id: string): boolean =>
    !shared.has(`${type}:${id}`) && !(type === "person" && id === app.owner);
  const read = async (): Promise<void> => {
    if (candidates !== null) {
      return;
    }
    const listed = await run(
      async (session) => await session.apps.members.candidates(app.id)
    );
    if (listed !== undefined) {
      setCandidates(listed);
    }
  };
  const share = async (member: AppMemberRef): Promise<void> => {
    setOpen(false);
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await session.apps.members.add(app.id, { ...member, role });
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  const people = candidates?.people.filter(({ id }) => isOffered("person", id));
  const teams = candidates?.teams.filter(({ id }) => isOffered("team", id));
  return (
    <div className="flex flex-col items-end gap-1">
      <Popover
        onOpenChange={(next: boolean) => {
          setOpen(next);
          if (next) {
            void read();
          }
        }}
        open={open}
      >
        <PopoverTrigger
          disabled={busy}
          render={<Button size="sm" variant="outline" />}
        >
          <UserPlusIcon data-icon="inline-start" />
          <Trans>Share</Trans>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80" variant="flush">
          <div className="flex items-center justify-between gap-2 border-b p-2">
            <span className="text-muted-foreground text-sm">
              <Trans>Share as</Trans>
            </span>
            <RoleSelect
              label={t`Role to share with`}
              onChange={setRole}
              role={role}
            />
          </div>
          {/* Names match as typed, as in the owner picker. */}
          <Command
            filter={(value: string, search: string) =>
              value.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0
            }
          >
            <CommandInput placeholder={t`Search people and teams`} />
            <CommandList>
              {people === undefined || teams === undefined ? (
                <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
                  <Spinner />
                  <Trans>Reading people and teams…</Trans>
                </div>
              ) : (
                <>
                  <CommandEmpty>
                    <Trans>Nobody else to share with.</Trans>
                  </CommandEmpty>
                  {people.length === 0 ? null : (
                    <CommandGroup heading={t`People`}>
                      {people.map((person) => (
                        <PersonOption
                          key={person.id}
                          onSelect={() => {
                            void share({ type: "person", id: person.id });
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
                            void share({ type: "team", id: team.id });
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
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** Someone the App is shared with: their role, and unsharing, for its builders. */
const MemberRow = ({
  app,
  member,
  editable,
}: {
  app: App;
  member: AppMember;
  editable: boolean;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const name = memberName(member, (team) => t`${team} (team)`);
  const ref: AppMemberRef = { type: member.type, id: member.id };
  const change = async (
    action: (
      session: Parameters<Parameters<typeof run>[0]>[0]
    ) => Promise<unknown>
  ): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await action(session);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <TableRow>
      <TableCell variant="card">
        <span className="flex flex-col">
          {name}
          <ErrorText>{failure}</ErrorText>
        </span>
      </TableCell>
      <TableCell variant="card">
        {editable ? (
          <RoleSelect
            disabled={busy}
            label={t`Role of ${name}`}
            onChange={(role) => {
              void change(
                async (session) =>
                  await session.apps.members.add(app.id, { ...ref, role })
              );
            }}
            role={member.role}
          />
        ) : (
          roleLabel(member.role)
        )}
      </TableCell>
      {editable ? (
        <TableCell className="text-right" variant="card">
          <AlertDialog>
            <AlertDialogTrigger
              disabled={busy}
              render={
                <Button
                  aria-label={t`Stop sharing with ${name}`}
                  size="sm"
                  variant="ghost"
                />
              }
            >
              <Trans>Unshare</Trans>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  <Trans>Stop sharing with {name}?</Trans>
                </AlertDialogTitle>
                <AlertDialogDescription>
                  <Trans>
                    Their open screens of it stop within seconds, and they can
                    no longer open it. You can share it with them again.
                  </Trans>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Trans>Cancel</Trans>
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    void change(async (session) => {
                      await session.apps.members.remove(app.id, ref);
                    });
                  }}
                  variant="destructive"
                >
                  <Trans>Stop sharing</Trans>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </TableCell>
      ) : null}
    </TableRow>
  );
};

/**
 * Who opens the App: its owner and the admins, who build it, and the
 * people and teams it is shared with, each as a user or a builder.
 */
export const AppMembers = ({
  app,
  members,
  identity,
}: {
  app: ViewedApp;
  members: AppMember[];
  identity: Identity;
}) => {
  const { t } = useLingui();
  const editable = sharesApp(app, identity);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-muted-foreground">
          {app.owner === identity.userId
            ? t`Created by you. It opens for you, the admins, and whoever it is shared with.`
            : t`It opens for the member who created it, the admins, and whoever it is shared with.`}
        </p>
        {editable ? <ShareApp app={app} members={members} /> : null}
      </div>
      {members.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>It isn’t shared with anyone.</Trans>
        </p>
      ) : (
        <div className="bg-card overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead variant="card">
                  <Trans>Shared with</Trans>
                </TableHead>
                <TableHead className="w-40" variant="card">
                  <Trans>Role</Trans>
                </TableHead>
                {editable ? (
                  <TableHead className="w-28" variant="card">
                    <span className="sr-only">
                      <Trans>Actions</Trans>
                    </span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <MemberRow
                  app={app}
                  editable={editable}
                  key={`${member.type}:${member.id}`}
                  member={member}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
};

/**
 * Share on the App's bar, for whoever may share it: whom it is shared with
 * is left out of its list once the Members tab's read is in.
 */
export const ShareOnBar = ({
  app,
  identity,
  members,
}: {
  app: ViewedApp;
  identity: Pick<Identity, "staff">;
  members: Promise<Loaded<AppMember[]>>;
}) =>
  sharesApp(app, identity) ? (
    <Await fallback={<ShareApp app={app} members={[]} />} promise={members}>
      {(listed) => (
        <ShareApp
          app={app}
          members={listed.state === "ready" ? listed.data : []}
        />
      )}
    </Await>
  ) : null;
