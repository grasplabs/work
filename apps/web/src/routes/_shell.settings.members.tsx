import { failureText } from "@grasp-os/shared/errors";
import { memberErrors } from "@grasp-os/shared/members";
import type {
  Guest,
  Invitation,
  Member,
  RemovedPeoplePage,
  RemovedPerson,
} from "@grasp-os/shared/members";
import { roleSchema } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import { Alert } from "@grasp-os/ui/components/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { DataTable } from "@grasp-os/ui/components/data-table";
import type { DataTableColumn } from "@grasp-os/ui/components/data-table";
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
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Text } from "@grasp-os/ui/components/text";
import { toast } from "@grasp-os/ui/components/toast";
import {
  CopyIcon,
  EllipsisIcon,
  Icon,
  InfoIcon,
  LogOutIcon,
  SearchIcon,
  TrashIcon,
} from "@grasp-os/ui/lib/icons";
import {
  colors,
  font,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useId, useState, useSyncExternalStore } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { formatDate } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { PersonCell } from "../frame/person-cell.tsx";
import { roleLabel } from "../labels.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { DirectoryReads } from "../settings/directory-reads.tsx";
import { RemovedActions, useRemovedPeople } from "../settings/erasures.tsx";
import { GuestActions } from "../settings/guests.tsx";
import {
  copyEmail,
  InvitationActions,
  InviteButton,
} from "../settings/invitations.tsx";
import { MemberSuspension } from "../settings/member-suspension.tsx";
import { roleItems, roleLines } from "../settings/roles.ts";
import { SettingsError, SettingsGroup } from "../settings/section.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { useNarrow } from "../use-narrow.ts";

// Settings → Members and roles, on one page as the library's Settings
// pattern has it: one compact card of people, each with their face, their
// email, whether the directory suspended them and why
// (settings/member-suspension.tsx), their role on one edge and a menu to
// end their sessions or remove them for good; the invitations nobody has taken up yet; and at its foot
// the people removed, quiet, and a way to erase them
// (settings/erasures.tsx). Guests, people outside the company invited to
// what is shared with them, are rows of the same table with a menu of
// their own (settings/guests.tsx). Then where the directory's daily read
// stands, once one was tried (settings/directory-reads.tsx). The teams
// have their own page (settings/teams.tsx). Core checks the role on every call; anyone else
// sees why they can't. The admin's own row has no actions: core refuses
// removing yourself or ending your own sessions, and demoting yourself
// (which core allows while another admin exists) is left out so nobody
// loses this page by accident.

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space["5"] },
  // As wide as the old frame's own search (176px), on a phone too: beside
  // the Roles mark and Invite it still fits the card's line (its actions
  // never shrink).
  search: { width: "176px" },
  // The search's empty frame while the people are read: an Input's height,
  // corner and hairline edge, its icon where it will be.
  searchWait: {
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    width: "176px",
    height: size.controlSm,
    paddingInlineStart: space["3"],
    borderRadius: `min(${radius.base}, calc(${size.controlSm} / 2))`,
    cornerShape: radius.shape,
    boxShadow: `inset 0 0 0 1px ${colors.input}`,
    color: colors.mutedForeground,
  },
  rowEnd: { display: "flex", alignItems: "center", gap: space["1"] },
  // A suspended member: their face and name, and why under them.
  person: { display: "flex", flexDirection: "column", gap: space["1"] },
  // The roles compared: each name over what it may do.
  roles: {
    display: "grid",
    gap: space["3"],
    margin: 0,
    padding: 0,
    maxWidth: size.fieldControlColumn,
  },
  roleName: {
    margin: 0,
    fontWeight: font.weightMedium,
    color: colors.foreground,
  },
  roleText: { margin: 0, color: colors.mutedForeground },
});

/** How many people a page of the table holds: the rest are a page further. */
const pageSize = 20;

/**
 * The members whose role is being changed and their list read again. A
 * row's role and its menu are cells of their own, so the menu reads it
 * here to stay off with the role.
 */
const changingRoles = new Set<string>();
const roleWatchers = new Set<() => void>();

const watchRoles = (changed: () => void): (() => void) => {
  roleWatchers.add(changed);
  return () => {
    roleWatchers.delete(changed);
  };
};

const markChanging = (userId: string, changing: boolean): void => {
  if (changing) {
    changingRoles.add(userId);
  } else {
    changingRoles.delete(userId);
  }
  for (const changed of roleWatchers) {
    changed();
  }
};

/**
 * Runs `change` with `userId`'s role marked as changing. Outside
 * components, as the React Compiler can't compile `try`/`finally`.
 */
const whileChanging = async (
  userId: string,
  change: () => Promise<void>
): Promise<void> => {
  markChanging(userId, true);
  try {
    await change();
  } finally {
    markChanging(userId, false);
  }
};

/** A member's role and the menu of what else may be done to them. */
const MemberActions = ({
  member,
  part,
  onRemoved,
}: {
  member: Member;
  /** Which of the row's cells: the role chosen, or the menu of what else may be done. */
  part: "role" | "menu";
  /** Once they are removed: their row, and what had the focus in it, is gone. */
  onRemoved: () => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const { busy, run } = useCoreAction();
  const roleChanging = useSyncExternalStore(
    watchRoles,
    () => changingRoles.has(member.userId),
    () => false
  );
  const [asking, setAsking] = useState<"promote" | "remove">();
  const { name } = member;
  // Names needn't be unique; with the email, each row's controls are.
  const who = `${member.name} (${member.email})`;
  const refresh = async (): Promise<void> => {
    // `sync` waits for the loader; without it, the router reloads the
    // page's data in the background and resolves at once.
    await router.invalidate({ sync: true });
  };
  const setRole = async (role: Role): Promise<void> => {
    await run(
      async ({ members }) => {
        await whileChanging(member.userId, async () => {
          await changeThenRefresh(async () => {
            await members.setRole(member.userId, role);
          }, refresh);
        });
      },
      // A menu's change has no place of its own: said as a toast.
      (failure) => {
        toast.error(failure);
      }
    );
  };
  const signOutEverywhere = async (): Promise<void> => {
    try {
      await changeThenRefresh(async () => {
        await core.withSession(async ({ members }) => {
          await members.revokeSessions(member.userId);
        });
      }, refresh);
    } catch (error) {
      // Core's reason, with its reference to quote; the item says it failed.
      toast.error(failureText(error));
      throw error;
    }
    toast.success(t`${name} is signed out everywhere.`);
  };
  // With none to disconnect, the removal alone is said. Outside the `try`
  // below, as the React Compiler can't compile a conditional within one.
  const removedSaid = (count: number): string =>
    count === 0
      ? t`${name} is removed.`
      : t`${name} is removed. ${plural(count, { one: "# personal connection was disconnected.", other: "# personal connections were disconnected." })}`;
  const remove = async (): Promise<void> => {
    try {
      const { connectionsDisconnected: count } = await core.withSession(
        async ({ members }) => await members.remove(member.userId)
      );
      toast.success(removedSaid(count));
    } catch (error) {
      // Removed, with some connections still to disconnect: the row goes
      // all the same, and the toast says why.
      // Core's reason, with its reference to quote, either way.
      toast.error(failureText(error));
      if (memberErrors.codeOf(error) !== "member.connections_pending") {
        await refresh();
        throw error;
      }
    }
    setAsking(undefined);
    await refresh();
    onRemoved();
  };
  return (
    <div {...stylex.props(styles.rowEnd)}>
      {part === "role" ? (
        <>
          <Select
            disabled={busy}
            items={roleItems()}
            onValueChange={(role) => {
              if (role === "admin") {
                setAsking("promote");
              } else if (roleSchema.safeParse(role).success && role !== null) {
                void setRole(roleSchema.parse(role));
              }
            }}
            value={member.role}
          >
            <SelectTrigger
              aria-label={t`Role of ${who}`}
              size="sm"
              variant="ghost"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent />
          </Select>
          <AlertDialog
            onOpenChange={(open) => {
              if (!open) {
                setAsking(undefined);
              }
            }}
            open={asking === "promote"}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t`Make ${name} an admin?`}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t`Admins can change anyone's role, end their sessions and remove them, other admins included.`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel />
                <Button
                  errorText={t`Not changed`}
                  onClick={async () => {
                    await setRole("admin");
                    setAsking(undefined);
                  }}
                >
                  {t`Make admin`}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : (
        <>
          <DropdownMenu>
            {/* Off while a role change is sent and the list read again, as the
              role is: nothing acts on a row that is about to change. */}
            <DropdownMenuTrigger asChild>
              <Button
                disabled={busy || roleChanging}
                aria-label={t`Actions for ${who}`}
                size="icon-sm"
                variant="ghost"
              >
                <Icon icon={EllipsisIcon} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                icon={CopyIcon}
                onSelect={() => {
                  void copyEmail(member.email, {
                    copied: t`Copied`,
                    failed: t`Copying didn't work`,
                  });
                }}
              >
                {t`Copy email`}
              </DropdownMenuItem>
              <DropdownMenuItem
                errorText={t`Not signed out`}
                icon={LogOutIcon}
                onSelect={signOutEverywhere}
              >
                {t`Sign out everywhere`}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                icon={TrashIcon}
                onSelect={() => {
                  setAsking("remove");
                }}
              >
                {t`Remove`}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <AlertDialog
            onOpenChange={(open) => {
              if (!open) {
                setAsking(undefined);
              }
            }}
            open={asking === "remove"}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t`Remove ${name}?`}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t`They are signed out everywhere, their personal connections are disconnected, and they cannot sign in again.`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel />
                <Button
                  errorText={t`Not removed`}
                  loadingText={t`Removing`}
                  onClick={remove}
                  variant="destructive"
                >
                  {t`Remove`}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
};

/** The three roles compared, each name over what it may do: in a popover from the card's head. */
const RolesButton = () => {
  const { t, i18n: lingui } = useLingui();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button aria-label={t`Roles`} size="icon-sm" variant="ghost">
          <Icon icon={InfoIcon} />
        </Button>
      </PopoverTrigger>
      {/* It only explains: focus stays on the button, so no ring frames the panel. */}
      <PopoverContent initialFocus="none">
        <PopoverTitle>{t`Roles`}</PopoverTitle>
        <dl {...stylex.props(styles.roles)}>
          {roleSchema.options.map((role) => (
            <div key={role}>
              <dt {...stylex.props(styles.roleName)}>{roleLabel(role)}</dt>
              <dd {...stylex.props(styles.roleText)}>
                {lingui._(roleLines[role])}
              </dd>
            </div>
          ))}
          <div>
            <dt {...stylex.props(styles.roleName)}>{t`Guest`}</dt>
            <dd {...stylex.props(styles.roleText)}>
              {t`People outside your organization, invited to what is shared with them. They reach nothing else.`}
            </dd>
          </div>
        </dl>
      </PopoverContent>
    </Popover>
  );
};

/**
 * One's own role, which one doesn't change here (core allows it while
 * another admin exists, but nobody should lose this page by accident): on
 * the same edge as the others', with the room their menu takes.
 */
const OwnRole = ({ role, label }: { role: Role; label: string }) => (
  <Select disabled items={roleItems()} value={role}>
    <SelectTrigger aria-label={label} size="sm" variant="ghost">
      <SelectValue />
    </SelectTrigger>
    <SelectContent />
  </Select>
);

/** One row of the people's table: a member, a guest, an invitation or someone removed, with its date. */
interface PersonRow {
  key: string;
  kind: "member" | "guest" | "invited" | "removed";
  name: string;
  email: string;
  /** When they joined, were invited or were removed. */
  at: string;
  invitedBy?: string;
  member?: Member;
  guest?: Guest;
  invitation?: Invitation;
  removed?: RemovedPerson;
}

/** The table's words, in the page's language. */
interface PeopleWords {
  name: string;
  since: string;
  role: string;
  guest: string;
  invited: string;
  yourRole: string;
  roleOf: (name: string) => string;
  /** On a phone, in place of an invited person's second line. */
  invitedShort: (date: string) => string;
  invitedOn: (date: string, by: string) => string;
  removedOn: (date: string) => string;
  removed: string;
  erased: string;
}

/** The role a row's person has or would join as, in words: for search and sorting. */
const roleOf = (row: PersonRow): string => {
  const role = row.member?.role ?? row.invitation?.role;
  return role === undefined ? "" : roleLabel(role);
};

/** The people's columns' words, in the reader's language. */
const usePeopleWords = (): PeopleWords => {
  const { t } = useLingui();
  return {
    name: t`Name`,
    since: t`Since`,
    role: t`Role`,
    guest: t`Guest`,
    invited: t`Invited`,
    yourRole: t`Your role`,
    roleOf: (name) => t`Role of ${name}`,
    invitedShort: (date) => t`Invited ${date}`,
    invitedOn: (date, by) => t`${date} by ${by}`,
    removedOn: (date) => t`Removed ${date}`,
    removed: t`Removed`,
    erased: t`Erased`,
  };
};

/** A row's state in words, so the search finds people by it: invited, removed or erased. */
const stateOf = (row: PersonRow, words: PeopleWords): string => {
  if (row.kind === "invited") {
    return words.invited;
  }
  if (row.kind !== "removed") {
    return "";
  }
  return (row.removed?.erasure?.completedAt ?? null) === null
    ? words.removed
    : words.erased;
};

/** The people's columns: who, since when, and their role with what can be done. */
const peopleColumns = ({
  words,
  me,
  narrow,
  onRemoved,
}: {
  words: PeopleWords;
  me: string;
  /** Below the phone's width, Since steps aside so Name and Role fit. */
  narrow: boolean;
  /** Once a member is removed, and their row with what had the focus in it. */
  onRemoved: () => void;
}): DataTableColumn<PersonRow>[] => {
  const columns: DataTableColumn<PersonRow>[] = [
    {
      id: "name",
      header: words.name,
      // While the people are read, a person's box: their circle, name and email.
      skeleton: "person",
      value: (row) => `${row.name} ${row.email} ${stateOf(row, words)}`,
      cell: (row) => {
        const date = formatDate(row.at);
        // On a phone Since steps aside: an invited or removed person's state stands under the name.
        if (narrow && row.kind === "invited") {
          return (
            <PersonCell detail={words.invitedShort(date)} name={row.name} />
          );
        }
        if (narrow && row.kind === "removed") {
          return <PersonCell detail={words.removedOn(date)} name={row.name} />;
        }
        const person = (
          <PersonCell
            name={row.name}
            {...(row.kind === "invited" || row.email === ""
              ? {}
              : { detail: row.email })}
          />
        );
        // Suspended by the directory: why, and where the way out is, under them.
        return row.member !== undefined && row.member.suspension !== null ? (
          <span {...stylex.props(styles.person)}>
            {person}
            <MemberSuspension member={row.member} />
          </span>
        ) : (
          person
        );
      },
    },
    {
      id: "since",
      header: words.since,
      value: (row) => row.at,
      cell: (row) => {
        const date = formatDate(row.at);
        if (row.kind === "invited") {
          return (
            <span {...stylex.props(styles.rowEnd)}>
              <Badge size="sm" variant="info">
                {words.invited}
              </Badge>
              {words.invitedOn(date, row.invitedBy ?? "")}
            </span>
          );
        }
        if (row.kind === "removed") {
          return (
            <Text as="span" size="sm" color="muted">
              {words.removedOn(date)}
            </Text>
          );
        }
        // Joined is what Since means: a member's cell is the date alone, and a
        // guest's the day they were invited, when they were let in.
        return date;
      },
    },
    {
      id: "role",
      header: words.role,
      align: "end",
      control: true,
      value: (row) => (row.kind === "guest" ? words.guest : roleOf(row)),
      cell: (row) => {
        if (row.kind === "guest") {
          // Nobody changes a guest's role: it reads as one's own does.
          return (
            <Select
              disabled
              items={[{ label: words.guest, value: "guest" }]}
              value="guest"
            >
              <SelectTrigger
                aria-label={words.roleOf(row.name)}
                size="sm"
                variant="ghost"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent />
            </Select>
          );
        }
        if (row.invitation !== undefined) {
          // What they join as, which nobody changes here: as one's own role reads.
          return (
            <OwnRole
              label={words.roleOf(row.name)}
              role={row.invitation.role}
            />
          );
        }
        if (row.member === undefined) {
          return null;
        }
        return row.member.userId === me ? (
          <OwnRole label={words.yourRole} role={row.member.role} />
        ) : (
          <MemberActions
            member={row.member}
            onRemoved={onRemoved}
            part="role"
          />
        );
      },
    },
    {
      id: "actions",
      header: "",
      align: "end",
      control: true,
      value: () => "",
      cell: (row) => {
        if (row.invitation !== undefined) {
          return <InvitationActions invitation={row.invitation} />;
        }
        if (row.removed !== undefined) {
          return <RemovedActions person={row.removed} />;
        }
        if (row.guest !== undefined) {
          return <GuestActions guest={row.guest} />;
        }
        if (row.member === undefined || row.member.userId === me) {
          return null;
        }
        return (
          <MemberActions
            member={row.member}
            onRemoved={onRemoved}
            part="menu"
          />
        );
      },
    },
  ];
  return narrow ? columns.filter((column) => column.id !== "since") : columns;
};

/**
 * The people as one table, the library's Members pattern as Ruben chose it
 * (with headers): Name with the face and email, Since with the date each
 * joined, was invited (and by whom) or was removed, and Role with what can
 * be done; the count, the search and Invite on the head's one line; paged
 * twenty at a time, the search over everyone. Guests, invited and removed
 * people are states of a row.
 */
const PeopleTable = ({
  members,
  guests,
  invitations,
  removed,
  me,
}: {
  members: Member[];
  guests: Guest[];
  invitations: Invitation[];
  removed: RemovedPeoplePage;
  me: string;
}) => {
  const { t } = useLingui();
  const [search, setSearch] = useState("");
  // Once someone is removed their row goes, with the menu that had the
  // focus: the search takes it, rather than the page's body.
  const searchId = useId();
  const gone = useRemovedPeople(removed);
  const narrow = useNarrow();
  const words = usePeopleWords();
  const rows: PersonRow[] = [
    ...members.map((member) => ({
      key: member.userId,
      kind: "member" as const,
      name: member.name,
      email: member.email,
      at: member.joinedAt,
      member,
    })),
    // A guest's name is their address: it stands alone, without a second line.
    ...guests.map((guest) => ({
      key: guest.userId,
      kind: "guest" as const,
      name: guest.email,
      email: "",
      at: guest.invitedAt,
      guest,
    })),
    ...invitations.map((invitation) => ({
      key: invitation.id,
      kind: "invited" as const,
      name: invitation.email,
      email: invitation.email,
      at: invitation.invitedAt,
      invitedBy: invitation.invitedBy,
      invitation,
    })),
    ...gone.people.map((person) => ({
      key: person.userId,
      kind: "removed" as const,
      name: person.name,
      email: person.email ?? "",
      at: person.removedAt,
      removed: person,
    })),
  ];
  return (
    <SettingsGroup
      actions={
        <>
          <RolesButton />
          <InputGroup style={styles.search} size="sm">
            <InputGroupAddon>
              <Icon icon={SearchIcon} />
            </InputGroupAddon>
            <InputGroupInput
              aria-label={t`Search members`}
              id={searchId}
              onValueChange={setSearch}
              placeholder={t`Search members`}
              type="search"
              value={search}
            />
          </InputGroup>
          <InviteButton />
        </>
      }
      flush
      footer={
        gone.more ? (
          <>
            <Button
              disabled={gone.busy}
              onClick={() => {
                void gone.showMore();
              }}
              size="sm"
              variant="ghost"
            >
              {t`Show older`}
            </Button>
            {gone.failure === undefined ? null : (
              <Alert variant="destructive">{gone.failure}</Alert>
            )}
          </>
        ) : undefined
      }
      title={t`Team members`}
    >
      {/* A column's being hidden is read as the table starts: it starts again when the width crosses the phone's. */}
      <DataTable
        key={narrow ? "narrow" : "wide"}
        aria-label={t`Members`}
        columns={peopleColumns({
          words,
          me,
          narrow,
          onRemoved: () => {
            document
              .querySelector<HTMLInputElement>(`[id="${searchId}"]`)
              ?.focus();
          },
        })}
        onQueryChange={setSearch}
        pageSize={pageSize}
        query={search}
        getRowId={(row) => row.key}
        // Someone invited is not here yet: their row fades toward its end.
        // Someone removed is greyed, their menu kept clear.
        getRowStatus={(row) => {
          if (row.kind === "invited") {
            return "pending";
          }
          return row.kind === "removed" ? "removed" : undefined;
        }}
        rows={rows}
        unit={{ one: t`person`, other: t`people` }}
      />
    </SettingsGroup>
  );
};

/**
 * Settings › Members and roles on one page: the people and guests, with
 * what each role may do over them.
 */
const MembersPage = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  return (
    <div {...stylex.props(styles.page)}>
      {page.state === "ready" ? (
        <PeopleTable
          guests={page.data.guests}
          invitations={page.data.invitations}
          me={identity.userId}
          members={page.data.members}
          removed={page.data.removed}
        />
      ) : (
        <SettingsGroup title={t`Members`}>
          <NotLoadedState heading="h3" page={page} />
        </SettingsGroup>
      )}
      {/* Nothing before a read was tried, or for anyone core refuses it. */}
      <DirectoryReads />
    </div>
  );
};

/**
 * The people's card while they are read: the card as the loaded one
 * stands (its title waiting, its head's actions in place), the table
 * waiting in its own `loading` with the
 * columns, label and page size it will have (the name's column a
 * person's placeholder), so its head and rows stand where they will.
 */
const MembersPending = () => {
  const { t } = useLingui();
  const words = usePeopleWords();
  const narrow = useNarrow();
  return (
    <SettingsGroup
      actions={
        // Roles and Invite need no data, so they stand as they will; the
        // search waits as its field's empty frame, in the search's box.
        <>
          <RolesButton />
          <div aria-hidden="true" {...stylex.props(styles.searchWait)}>
            <Icon icon={SearchIcon} />
          </div>
          <InviteButton />
        </>
      }
      flush
      loading
      title=""
    >
      <DataTable<PersonRow>
        aria-label={t`Members`}
        columns={peopleColumns({
          words,
          me: "",
          narrow,
          onRemoved: () => {
            // Nobody is removed while the people are read.
          },
        })}
        getRowId={(row) => row.key}
        loading
        pageSize={pageSize}
        rows={[]}
        unit={{ one: t`person`, other: t`people` }}
      />
    </SettingsGroup>
  );
};

export const Route = createFileRoute("/_shell/settings/members")({
  pendingComponent: MembersPending,
  errorComponent: SettingsError,
  component: MembersPage,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => {
      const [members, invitations, guests, removed] = await Promise.all([
        session.members.list(),
        session.members.invitations(),
        session.members.guests(),
        session.members.removed(),
      ]);
      return { members, invitations, guests, removed };
    }),
});
