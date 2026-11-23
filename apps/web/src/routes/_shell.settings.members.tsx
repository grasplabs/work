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
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
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
  PopoverHeader,
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
import {
  CopyIcon,
  EllipsisIcon,
  Icon,
  InfoIcon,
  LogOutIcon,
  SearchIcon,
  TrashIcon,
} from "@grasp-os/ui/lib/icons";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState, useSyncExternalStore } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { formatDate } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { roleLabel } from "../labels.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { ConfirmAction } from "../settings/confirm-action.tsx";
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
import {
  Failure,
  SettingsError,
  SettingsGroup,
  SettingsStack,
} from "../settings/section.tsx";
import { settingsToast } from "../settings/settings-toast.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// Settings › Members and roles, on one page as Damsko's settings pattern
// has it: one card of people, each with their face, their email, whether
// the directory suspended them and why (settings/member-suspension.tsx),
// their role on one edge and a menu to end their sessions or remove them
// for good; the invitations nobody has taken up yet; and the people
// removed, quiet, and a way to erase them (settings/erasures.tsx). Guests,
// people outside the company invited to what is shared with them, are
// rows of the same table with a menu of their own (settings/guests.tsx).
// Then where the directory's daily read stands, once one was tried
// (settings/directory-reads.tsx). The teams have their own page
// (settings/teams.tsx). Core checks the role on every call; anyone else
// sees why they can't. The admin's own row has no actions: core refuses
// removing yourself or ending your own sessions, and demoting yourself
// (which core allows while another admin exists) is left out so nobody
// loses this page by accident.

const styles = stylex.create({
  // As wide as a header's search; on a phone narrower, so beside the Roles
  // mark and Invite it still fits the card's line.
  search: { width: { default: "14rem", [media.maxSm]: "8rem" } },
  // A person's face beside their name and email.
  person: {
    display: "flex",
    alignItems: "center",
    gap: space[3],
    minWidth: 0,
  },
  words: { display: "grid", minWidth: 0 },
  // A suspended member: their face and name, and why under them.
  stack: { display: "flex", flexDirection: "column", gap: space[1] },
  since: { display: "flex", alignItems: "center", gap: space[2] },
  // The roles compared: each name over what it may do.
  roles: { display: "grid", gap: space[3], margin: 0, padding: 0 },
  roleText: { margin: 0 },
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

/** A member's role, and the question before making them an admin. */
const MemberRole = ({ member }: { member: Member }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, run } = useCoreAction();
  const [asking, setAsking] = useState(false);
  const { name } = member;
  // Names needn't be unique; with the email, each row's controls are.
  const who = `${member.name} (${member.email})`;
  const setRole = async (role: Role): Promise<void> => {
    await run(
      async ({ members }) => {
        await whileChanging(member.userId, async () => {
          await changeThenRefresh(
            async () => {
              await members.setRole(member.userId, role);
            },
            async () => {
              // `sync` waits for the loader.
              await router.invalidate({ sync: true });
            }
          );
        });
      },
      // A menu's change has no place of its own: said as a toast.
      (failure) => {
        settingsToast.error(failure);
      }
    );
  };
  return (
    <>
      <Select
        disabled={busy}
        items={roleItems()}
        onValueChange={(role) => {
          if (role === "admin") {
            setAsking(true);
          } else if (role !== null && roleSchema.safeParse(role).success) {
            void setRole(roleSchema.parse(role));
          }
        }}
        value={member.role}
      >
        <SelectTrigger aria-label={t`Role of ${who}`} size="sm" variant="ghost">
          <SelectValue />
        </SelectTrigger>
        <SelectContent />
      </Select>
      <ConfirmAction
        action={async () => {
          await setRole("admin");
        }}
        description={t`Admins can change anyone's role, end their sessions and remove them, other admins included.`}
        errorLabel={t`Not changed`}
        label={t`Make admin`}
        onOpenChange={setAsking}
        open={asking}
        title={t`Make ${name} an admin?`}
        variant="default"
      />
    </>
  );
};

/** The menu of what else may be done to a member: copy, sign out, remove. */
const MemberMenu = ({ member }: { member: Member }) => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const roleChanging = useSyncExternalStore(
    watchRoles,
    () => changingRoles.has(member.userId),
    () => false
  );
  const [asking, setAsking] = useState(false);
  const { name } = member;
  const who = `${member.name} (${member.email})`;
  const refresh = async (): Promise<void> => {
    await router.invalidate({ sync: true });
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
      settingsToast.error(failureText(error));
      throw error;
    }
    settingsToast.success(t`${name} is signed out everywhere.`);
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
      settingsToast.success(removedSaid(count));
    } catch (error) {
      // Removed, with some connections still to disconnect: the row goes
      // all the same, and the toast says why. Core's reason, with its
      // reference to quote, either way.
      settingsToast.error(failureText(error));
      if (memberErrors.codeOf(error) !== "member.connections_pending") {
        await refresh();
        throw error;
      }
    }
    await refresh();
  };
  return (
    <>
      <DropdownMenu>
        {/* Off while a role change is sent and the list read again, as the
          role is: nothing acts on a row that is about to change. */}
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={t`Actions for ${who}`}
            disabled={roleChanging}
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
            errorLabel={t`Not signed out`}
            icon={LogOutIcon}
            onSelect={signOutEverywhere}
          >
            {t`Sign out everywhere`}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            icon={TrashIcon}
            onSelect={() => {
              setAsking(true);
            }}
            variant="destructive"
          >
            {t`Remove`}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmAction
        action={remove}
        description={t`They are signed out everywhere, their personal connections are disconnected, and they cannot sign in again.`}
        errorLabel={t`Not removed`}
        label={t`Remove`}
        loadingLabel={t`Removing`}
        onOpenChange={setAsking}
        open={asking}
        title={t`Remove ${name}?`}
      />
    </>
  );
};

/** The three roles compared, each name over what it may do: in a popover from the card's head. */
const RolesButton = () => {
  const { t, i18n } = useLingui();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button aria-label={t`Roles`} size="icon-xs" variant="ghost">
          <Icon icon={InfoIcon} />
        </Button>
      </PopoverTrigger>
      {/* It only explains: focus stays on the button. */}
      <PopoverContent initialFocus="none">
        <PopoverHeader>
          <PopoverTitle>{t`Roles`}</PopoverTitle>
        </PopoverHeader>
        <dl {...stylex.props(styles.roles)}>
          {roleSchema.options.map((role) => (
            <div key={role}>
              <dt>
                <Text as="span" color="default" size="sm" weight="medium">
                  {roleLabel(role)}
                </Text>
              </dt>
              <dd {...stylex.props(styles.roleText)}>
                <Text as="span" color="muted" size="sm">
                  {i18n._(roleLines[role])}
                </Text>
              </dd>
            </div>
          ))}
          <div>
            <dt>
              <Text as="span" color="default" size="sm" weight="medium">
                {t`Guest`}
              </Text>
            </dt>
            <dd {...stylex.props(styles.roleText)}>
              <Text as="span" color="muted" size="sm">
                {t`People outside your organization, invited to what is shared with them. They reach nothing else.`}
              </Text>
            </dd>
          </div>
        </dl>
      </PopoverContent>
    </Popover>
  );
};

/**
 * A role nobody changes here (one's own, a guest's, what an invitation
 * joins as): on the same edge as the others', read-only.
 */
const FixedRole = ({
  value,
  items,
  label,
}: {
  value: string;
  items: { value: string; label: string }[];
  label: string;
}) => (
  <Select disabled items={items} value={value}>
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

/** A person's cell: their face, their name, and their email under it. */
const PersonCell = ({ name, detail }: { name: string; detail?: string }) => (
  <span {...stylex.props(styles.person)}>
    <Avatar decorative name={name} size="sm">
      <AvatarFallback />
    </Avatar>
    <span {...stylex.props(styles.words)}>
      <Text as="span" color="default" size="sm" truncate>
        {name}
      </Text>
      {detail === undefined ? null : (
        <Text as="span" color="muted" size="sm" truncate>
          {detail}
        </Text>
      )}
    </span>
  </span>
);

/** The people's columns: who, since when, and their role with what can be done. */
const peopleColumns = ({
  words,
  me,
}: {
  words: PeopleWords;
  me: string;
}): DataTableColumn<PersonRow>[] => [
  {
    id: "name",
    header: words.name,
    // While the people are read, a person's box: their circle, name and email.
    skeleton: "person",
    value: (row) => `${row.name} ${row.email} ${stateOf(row, words)}`,
    cell: (row) => {
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
        <span {...stylex.props(styles.stack)}>
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
    // On a phone Since steps aside, so Name and Role fit.
    hideBelow: "sm",
    value: (row) => row.at,
    cell: (row) => {
      const date = formatDate(row.at);
      if (row.kind === "invited") {
        return (
          <span {...stylex.props(styles.since)}>
            <Badge size="sm" variant="info">
              {words.invited}
            </Badge>
            {words.invitedOn(date, row.invitedBy ?? "")}
          </span>
        );
      }
      if (row.kind === "removed") {
        return (
          <Text as="span" color="muted" size="sm">
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
          <FixedRole
            items={[{ label: words.guest, value: "guest" }]}
            label={words.roleOf(row.name)}
            value="guest"
          />
        );
      }
      if (row.invitation !== undefined) {
        // What they join as, which nobody changes here: as one's own role reads.
        return (
          <FixedRole
            items={roleItems()}
            label={words.roleOf(row.name)}
            value={row.invitation.role}
          />
        );
      }
      if (row.member === undefined) {
        return null;
      }
      return row.member.userId === me ? (
        <FixedRole
          items={roleItems()}
          label={words.yourRole}
          value={row.member.role}
        />
      ) : (
        <MemberRole member={row.member} />
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
      return <MemberMenu member={row.member} />;
    },
  },
];

/** The search over the people, in the card's head. */
const PeopleSearch = ({
  value,
  onValueChange,
}: {
  value: string;
  onValueChange: (value: string) => void;
}) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.search)}>
      <InputGroup size="sm">
        <InputGroupAddon>
          <Icon icon={SearchIcon} />
        </InputGroupAddon>
        <InputGroupInput
          aria-label={t`Search members`}
          onValueChange={onValueChange}
          placeholder={t`Search members`}
          type="search"
          value={value}
        />
      </InputGroup>
    </div>
  );
};

/**
 * The people as one table: Name with the face and email, Since with the
 * date each joined, was invited (and by whom) or was removed, and Role
 * with what can be done; the search, Roles and Invite on the head's one
 * line; paged twenty at a time, the search over everyone. Guests, invited
 * and removed people are states of a row.
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
  const gone = useRemovedPeople(removed);
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
          <PeopleSearch onValueChange={setSearch} value={search} />
          <InviteButton />
        </>
      }
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
            <Failure>{gone.failure}</Failure>
          </>
        ) : undefined
      }
      title={t`Team members`}
    >
      <DataTable
        aria-label={t`Members`}
        columns={peopleColumns({ words, me })}
        getRowId={(row) => row.key}
        // Someone invited is not here yet: their row fades toward its end.
        // Someone removed is greyed, their menu kept clear.
        getRowStatus={(row) => {
          if (row.kind === "invited") {
            return "pending";
          }
          return row.kind === "removed" ? "removed" : undefined;
        }}
        onQueryChange={setSearch}
        pageSize={pageSize}
        query={search}
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
    <SettingsStack>
      {page.state === "ready" ? (
        <PeopleTable
          guests={page.data.guests}
          invitations={page.data.invitations}
          me={identity.userId}
          members={page.data.members}
          removed={page.data.removed}
        />
      ) : (
        <SettingsGroup flush={false} title={t`Members`}>
          <NotLoadedState heading="h3" page={page} />
        </SettingsGroup>
      )}
      {/* Nothing before a read was tried, or for anyone core refuses it. */}
      <DirectoryReads />
    </SettingsStack>
  );
};

/**
 * The people's card while they are read: the card as the loaded one
 * stands (its head's actions in place), the table waiting in its own
 * `loading` with the columns, label and page size it will have.
 */
const MembersPending = () => {
  const { t } = useLingui();
  const words = usePeopleWords();
  return (
    <SettingsGroup
      actions={
        // Roles and Invite need no data, so they stand as they will.
        <>
          <RolesButton />
          <InviteButton />
        </>
      }
      title={t`Team members`}
    >
      <DataTable
        aria-label={t`Members`}
        columns={peopleColumns({ words, me: "" })}
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
