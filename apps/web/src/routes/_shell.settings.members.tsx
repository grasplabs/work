import type { Member } from "@grasp-os/shared/members";
import { roleSchema } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  EllipsisIcon,
  LogOutIcon,
  SearchIcon,
  UserMinusIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { NotLoadedState } from "../frame/page-states.tsx";
import { initials } from "../frame/person-menu.tsx";
import { roleLabel } from "../labels.ts";
import { loadFromCore } from "../load-from-core.tsx";
import {
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Offboarding, for admins: the organization's members, each with their
// role, a way to end their sessions, and a way to remove them for good.
// Core checks the role on every call; anyone else sees why they can't.
// The admin's own row has no actions: core refuses removing yourself or
// ending your own sessions, and demoting yourself (which core allows while
// another admin exists) is left out so nobody loses this page by accident.

/** The roles to pick from, in the page's language. */
const roleItems = (): { label: string; value: Role }[] =>
  roleSchema.options.map((role) => ({ label: roleLabel(role), value: role }));

type Change = (members: Session["members"]) => Promise<unknown>;

/** Shows why a change failed, or what it did, or clears both when given nothing. */
type Report = (failure?: string, done?: string) => void;

const MemberActions = ({
  member,
  onNotice,
  onRemoved,
}: {
  member: Member;
  onNotice: Report;
  /** Once they are removed: their row, and what had the focus in it, is gone. */
  onRemoved: () => void;
}) => {
  const router = useRouter();
  const { busy, failure, run: runAction } = useCoreAction();
  const [confirming, setConfirming] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const { t } = useLingui();
  const roles = roleItems();
  const { name } = member;
  // Names needn't be unique; with the email, each row's controls are.
  const who = `${member.name} (${member.email})`;
  const run = async (change: Change, report?: Report): Promise<void> => {
    onNotice();
    setConfirming(false);
    setPromoting(false);
    await runAction(async (session) => {
      // `sync` waits for the loader; without it, the router reloads the
      // page's data in the background and resolves at once.
      await changeThenRefresh(
        async () => await change(session.members),
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    }, report);
  };
  const remove = async (): Promise<void> => {
    // Shown on the page: a removal that went through takes this row with
    // it, even when it failed to disconnect everything
    // (`member.connections_pending`).
    let removed = false;
    await run(async (members) => {
      const { connectionsDisconnected: count } = await members.remove(
        member.userId
      );
      removed = true;
      onNotice(
        undefined,
        t`${name} is removed. ${plural(count, { one: "# personal connection was disconnected.", other: "# personal connections were disconnected." })}`
      );
    }, onNotice);
    if (removed) {
      onRemoved();
    }
  };
  const setRole = (role: Role): void => {
    void run(async (members) => {
      await members.setRole(member.userId, role);
    });
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <Select
          items={roles}
          value={member.role}
          disabled={busy}
          onValueChange={(role: Role | null) => {
            if (role === "admin") {
              setPromoting(true);
            } else if (role !== null) {
              setRole(role);
            }
          }}
        >
          <SelectTrigger aria-label={t`Role of ${who}`} className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {roles.map((role) => (
              <SelectItem key={role.value} value={role.value}>
                {role.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Dialog open={promoting} onOpenChange={setPromoting}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                <Trans>Make {name} an admin?</Trans>
              </DialogTitle>
              <DialogDescription>
                <Trans>
                  Admins can change anyone&apos;s role, end their sessions and
                  remove them, other admins included.
                </Trans>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter showCloseButton>
              <Button
                disabled={busy}
                onClick={() => {
                  setRole("admin");
                }}
              >
                <Trans>Make admin</Trans>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t`Actions for ${who}`}
            disabled={busy}
            render={<Button size="icon-sm" variant="ghost" />}
          >
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              onClick={() => {
                void run(async (members) => {
                  await members.revokeSessions(member.userId);
                  onNotice(undefined, t`${name} is signed out everywhere.`);
                });
              }}
            >
              <LogOutIcon />
              <Trans>Sign out everywhere</Trans>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                setConfirming(true);
              }}
              variant="destructive"
            >
              <UserMinusIcon />
              <Trans>Remove</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Dialog open={confirming} onOpenChange={setConfirming}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                <Trans>Remove {name}?</Trans>
              </DialogTitle>
              <DialogDescription>
                <Trans>
                  They are signed out everywhere, their personal connections are
                  disconnected, and they cannot sign in again.
                </Trans>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter showCloseButton>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  void remove();
                }}
              >
                <Trans>Remove</Trans>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** Whether `member` is what the search names: in their name or email. */
const matches = (member: Member, search: string): boolean => {
  const words = search.trim().toLocaleLowerCase();
  return (
    words === "" ||
    member.name.toLocaleLowerCase().includes(words) ||
    member.email.toLocaleLowerCase().includes(words)
  );
};

/**
 * The members, as the prototype lists them (`routes/settings/members.tsx`):
 * each with their avatar, name and email, their role and a menu. The
 * admin's own row only shows their role.
 */
const MembersList = ({ members, me }: { members: Member[]; me: string }) => {
  const { t } = useLingui();
  const [notice, setNotice] = useState<{ failure?: string; done?: string }>({});
  const [search, setSearch] = useState("");
  const searchField = useRef<HTMLInputElement>(null);
  const people = members.length;
  const shown = members.filter((member) => matches(member, search));
  return (
    <SettingsSection
      action={
        <InputGroup className="w-56">
          <InputGroupInput
            aria-label={t`Search members`}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            placeholder={t`Search`}
            ref={searchField}
            value={search}
          />
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
        </InputGroup>
      }
      description={
        <Plural
          one="# person has access. Members join by signing in with your organization’s account; there are no invitations to send."
          other="# people have access. Members join by signing in with your organization’s account; there are no invitations to send."
          value={people}
        />
      }
      title={t`Members and roles`}
    >
      {notice.failure === undefined && notice.done === undefined ? null : (
        <div className="border-t px-5 py-3">
          <ErrorText>{notice.failure}</ErrorText>
          {notice.done === undefined ? null : (
            <output className="text-muted-foreground">{notice.done}</output>
          )}
        </div>
      )}
      {shown.length === 0 ? (
        <p className="text-muted-foreground border-t px-5 py-6 text-center">
          <Trans>Nobody matches.</Trans>
        </p>
      ) : null}
      {shown.map((member) => (
        <div
          className="flex items-center gap-3 border-t px-5 py-3"
          key={member.userId}
        >
          <Avatar className="size-8">
            <AvatarFallback>{initials(member.name)}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-2">
              <span className="truncate">{member.name}</span>
              {member.userId === me ? (
                <Badge variant="secondary">
                  <Trans>You</Trans>
                </Badge>
              ) : null}
            </span>
            <span className="text-muted-foreground truncate">
              {member.email}
            </span>
          </div>
          {member.userId === me ? (
            <Badge variant="outline">{roleLabel(member.role)}</Badge>
          ) : (
            <MemberActions
              member={member}
              onRemoved={() => {
                searchField.current?.focus();
              }}
              onNotice={(failure, done) => {
                setNotice({
                  ...(failure === undefined ? {} : { failure }),
                  ...(done === undefined ? {} : { done }),
                });
              }}
            />
          )}
        </div>
      ))}
    </SettingsSection>
  );
};

const Members = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  if (page.state !== "ready") {
    return (
      <SettingsSection title={t`Members and roles`}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsSection>
    );
  }
  return <MembersList me={identity.userId} members={page.data} />;
};

export const Route = createFileRoute("/_shell/settings/members")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: Members,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => await session.members.list()),
});
