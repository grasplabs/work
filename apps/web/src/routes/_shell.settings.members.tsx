import { failureText } from "@grasp-os/shared/errors";
import { memberErrors } from "@grasp-os/shared/members";
import type {
  Invitation,
  Member,
  RemovedPeoplePage,
  RemovedPerson,
} from "@grasp-os/shared/members";
import { isMemberAdmin, roleSchema } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { formatDate } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogContent,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { PageSkeletonTable } from "../grasp/blocks/page-skeleton-table/page-skeleton-table.tsx";
import { PageSkeletonToolbar } from "../grasp/blocks/page-skeleton-toolbar/page-skeleton-toolbar.tsx";
import { Button } from "../grasp/button/index.ts";
import { DataTable, DataTablePerson } from "../grasp/data-table/index.ts";
import type { DataTableColumn } from "../grasp/data-table/index.ts";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import {
  Copy,
  Info,
  More,
  Search,
  SignOut,
  Trash,
} from "../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../grasp/popover/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
} from "../grasp/select/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { roleLabel } from "../labels.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { DirectoryReads } from "../settings/directory-reads.tsx";
import { RemovedActions, useRemovedPeople } from "../settings/erasures.tsx";
import { Guests } from "../settings/guests.tsx";
import {
  copyEmail,
  InvitationActions,
  InviteButton,
} from "../settings/invitations.tsx";
import { MemberSuspension } from "../settings/member-suspension.tsx";
import { roleItems, roleLines } from "../settings/roles.ts";
import { SectionNotLoaded, SettingsError } from "../settings/section.tsx";
import { TeamsPanel } from "../settings/teams.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { useNarrow } from "../use-narrow.ts";

// Settings → Members and roles, on one page as the library's Settings
// pattern has it: one compact card of people, each with their face, their
// email, whether the directory suspended them and why
// (settings/member-suspension.tsx), their role on one edge and a menu to
// end their sessions or remove them for good; the invitations nobody has taken up yet; and at its foot
// the people removed, quiet, and a way to erase them
// (settings/erasures.tsx). Then where the directory's daily read stands,
// once one was tried (settings/directory-reads.tsx), the teams, for the organization's own
// admins (settings/teams.tsx), and, last, what each role may do. Core checks the role on every call; anyone else
// sees why they can't. The admin's own row has no actions: core refuses
// removing yourself or ending your own sessions, and demoting yourself
// (which core allows while another admin exists) is left out so nobody
// loses this page by accident.

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: grasp.space5 },
  // As wide as the header's own search, on a phone too: beside the Roles
  // mark and Invite it still fits the card's line (its actions never shrink).
  search: { width: grasp.frameSearch },
  notice: { padding: grasp.space4 },
  // Older removed people, asked for under the ones shown.
  older: {
    display: "grid",
    justifyItems: "start",
    gap: grasp.space2,
    paddingBlock: grasp.space2,
    paddingInline: grasp.tableCellInline,
  },
  rowEnd: { display: "flex", alignItems: "center", gap: grasp.space1 },
  // A suspended member: their face and name, and why under them.
  person: { display: "flex", flexDirection: "column", gap: grasp.space1 },
  // Your own row has no menu: its room is kept, so every role stands on one edge.
  menuRoom: { width: grasp.controlSm, flexShrink: 0 },
  // The roles compared: each name over what it may do.
  roles: {
    display: "grid",
    gap: grasp.space3,
    margin: 0,
    padding: 0,
    maxWidth: grasp.controlColumn,
  },
  roleName: { margin: 0, fontWeight: grasp.weightMedium, color: grasp.ink },
  roleText: { margin: 0, color: grasp.muted },
});

/** How many people a page of the table holds: the rest are a page further. */
const pageSize = 20;

/** What a change did, or why it failed. */
interface Notice {
  failure?: string;
  done?: string;
}

/** A member's role and the menu of what else may be done to them. */
const MemberActions = ({
  member,
  part,
  onNotice,
  onRemoved,
}: {
  member: Member;
  /** Which of the row's cells: the role chosen, or the menu of what else may be done. */
  part: "role" | "menu";
  onNotice: (notice: Notice) => void;
  /** Once they are removed: their row, and what had the focus in it, is gone. */
  onRemoved: () => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const { busy, run } = useCoreAction();
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
    onNotice({});
    await run(
      async ({ members }) => {
        await changeThenRefresh(async () => {
          await members.setRole(member.userId, role);
        }, refresh);
      },
      (failure) => {
        onNotice({ failure });
      }
    );
  };
  const signOutEverywhere = async (): Promise<void> => {
    onNotice({});
    try {
      await changeThenRefresh(async () => {
        await core.withSession(async ({ members }) => {
          await members.revokeSessions(member.userId);
        });
      }, refresh);
    } catch (error) {
      // Core's reason, with its reference to quote; the item says it failed.
      onNotice({ failure: failureText(error) });
      throw error;
    }
    onNotice({ done: t`${name} is signed out everywhere.` });
  };
  // With none to disconnect, the removal alone is said. Outside the `try`
  // below, as the React Compiler can't compile a conditional within one.
  const removedSaid = (count: number): string =>
    count === 0
      ? t`${name} is removed.`
      : t`${name} is removed. ${plural(count, { one: "# personal connection was disconnected.", other: "# personal connections were disconnected." })}`;
  const remove = async (): Promise<void> => {
    onNotice({});
    try {
      const { connectionsDisconnected: count } = await core.withSession(
        async ({ members }) => await members.remove(member.userId)
      );
      onNotice({
        done: removedSaid(count),
      });
    } catch (error) {
      // Removed, with some connections still to disconnect: the row goes
      // all the same, and the notice says why.
      // Core's reason, with its reference to quote, either way.
      onNotice({ failure: failureText(error) });
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
              variant="text"
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
              <AlertDialogTitle>{t`Make ${name} an admin?`}</AlertDialogTitle>
              <AlertDialogDescription>
                {t`Admins can change anyone's role, end their sessions and remove them, other admins included.`}
              </AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
                <AlertDialogAction
                  action={async () => {
                    await setRole("admin");
                  }}
                  failedLabel={t`Not changed`}
                  variant="ink"
                >
                  {t`Make admin`}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : (
        <>
          <DropdownMenu>
            {/* Off while a role change is sent and the list read again, as the
              role is: nothing acts on a row that is about to change. */}
            <DropdownMenuTrigger
              disabled={busy}
              icon={More}
              aria-label={t`Actions for ${who}`}
              size="sm"
              variant="ghost"
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                icon={Copy}
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
                action={signOutEverywhere}
                failedLabel={t`Not signed out`}
                icon={SignOut}
                mirrorIcon
              >
                {t`Sign out everywhere`}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="danger"
                icon={Trash}
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
              <AlertDialogTitle>{t`Remove ${name}?`}</AlertDialogTitle>
              <AlertDialogDescription>
                {t`They are signed out everywhere, their personal connections are disconnected, and they cannot sign in again.`}
              </AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
                <AlertDialogAction
                  action={remove}
                  failedLabel={t`Not removed`}
                  variant="danger"
                  workingLabel={t`Removing`}
                >
                  {t`Remove`}
                </AlertDialogAction>
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
      <PopoverTrigger
        aria-label={t`Roles`}
        icon={Info}
        size="sm"
        variant="ghost"
      />
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
    <SelectTrigger aria-label={label} size="sm" variant="text">
      <SelectValue />
    </SelectTrigger>
    <SelectContent />
  </Select>
);

/** One row of the people's table: a member, an invitation or someone removed, with its date. */
interface PersonRow {
  key: string;
  kind: "member" | "invited" | "removed";
  name: string;
  email: string;
  /** When they joined, were invited or were removed. */
  at: string;
  invitedBy?: string;
  member?: Member;
  invitation?: Invitation;
  removed?: RemovedPerson;
}

/** The table's words, in the page's language. */
interface PeopleWords {
  name: string;
  since: string;
  role: string;
  invited: string;
  yourRole: string;
  roleOf: (name: string) => string;
  /** On a phone, in place of an invited person's second line. */
  invitedShort: (date: string) => string;
  invitedOn: (date: string, by: string) => string;
  removedOn: (date: string) => string;
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
    invited: t`Invited`,
    yourRole: t`Your role`,
    roleOf: (name) => t`Role of ${name}`,
    invitedShort: (date) => t`Invited ${date}`,
    invitedOn: (date, by) => t`${date} by ${by}`,
    removedOn: (date) => t`Removed ${date}`,
  };
};

/** The people's columns: who, since when, and their role with what can be done. */
const peopleColumns = ({
  words,
  me,
  narrow,
  onNotice,
}: {
  words: PeopleWords;
  me: string;
  /** Below the phone's width, Since steps aside so Name and Role fit. */
  narrow: boolean;
  onNotice: (notice: Notice) => void;
}): DataTableColumn<PersonRow>[] => {
  const columns: DataTableColumn<PersonRow>[] = [
    {
      key: "name",
      header: words.name,
      // While the people are read, a person's box: their circle, name and email.
      placeholder: "person",
      value: (row) => `${row.name} ${row.email}`,
      cell: (row) => {
        const date = formatDate(row.at);
        // On a phone Since steps aside: an invited or removed person's state stands under the name.
        if (narrow && row.kind === "invited") {
          return (
            <DataTablePerson
              detail={words.invitedShort(date)}
              name={row.name}
            />
          );
        }
        if (narrow && row.kind === "removed") {
          return (
            <DataTablePerson detail={words.removedOn(date)} name={row.name} />
          );
        }
        const person = (
          <DataTablePerson
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
      key: "since",
      header: words.since,
      value: (row) => row.at,
      cell: (row) => {
        const date = formatDate(row.at);
        if (row.kind === "invited") {
          return (
            <span {...stylex.props(styles.rowEnd)}>
              <Badge size="sm" tone="info">
                {words.invited}
              </Badge>
              {words.invitedOn(date, row.invitedBy ?? "")}
            </span>
          );
        }
        if (row.kind === "removed") {
          return (
            <Text element="span" size="sm" tone="muted">
              {words.removedOn(date)}
            </Text>
          );
        }
        // Joined is what Since means: a member's cell is the date alone.
        return date;
      },
    },
    {
      key: "role",
      header: words.role,
      align: "end",
      control: true,
      value: (row) => roleOf(row),
      cell: (row) => {
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
            onNotice={onNotice}
            onRemoved={() => {
              // The table reads again, without their row.
            }}
            part="role"
          />
        );
      },
    },
    {
      key: "actions",
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
        if (row.member === undefined || row.member.userId === me) {
          return null;
        }
        return (
          <MemberActions
            member={row.member}
            onNotice={onNotice}
            onRemoved={() => {
              // The table reads again, without their row.
            }}
            part="menu"
          />
        );
      },
    },
  ];
  return narrow ? columns.filter((column) => column.key !== "since") : columns;
};

/**
 * The people as one table, the library's Members pattern as Ruben chose it
 * (with headers): Name with the face and email, Since with the date each
 * joined, was invited (and by whom) or was removed, and Role with what can
 * be done; the count, the search and Invite on the head's one line; paged
 * twenty at a time, the search over everyone. Invited and removed people
 * are states of a row.
 */
const PeopleTable = ({
  members,
  invitations,
  removed,
  me,
}: {
  members: Member[];
  invitations: Invitation[];
  removed: RemovedPeoplePage;
  me: string;
}) => {
  const { t } = useLingui();
  const [notice, setNotice] = useState<Notice>({});
  const [search, setSearch] = useState("");
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
    <SectionCard
      variant="grouped"
      density="compact"
      actions={
        <>
          <RolesButton />
          <InputGroup layout={styles.search} size="sm">
            <InputGroupText icon={Search} />
            <InputGroupInput
              aria-label={t`Search members`}
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
              <Alert tone="danger">{gone.failure}</Alert>
            )}
          </>
        ) : undefined
      }
      title={t`Team members`}
    >
      {notice.failure === undefined && notice.done === undefined ? null : (
        <div {...stylex.props(styles.notice)}>
          {notice.failure === undefined ? (
            <Alert tone="success">{notice.done}</Alert>
          ) : (
            <Alert tone="danger">{notice.failure}</Alert>
          )}
        </div>
      )}
      {/* A column's being hidden is read as the table starts: it starts again when the width crosses the phone's. */}
      <DataTable
        key={narrow ? "narrow" : "wide"}
        columns={peopleColumns({
          words,
          me,
          narrow,
          onNotice: setNotice,
        })}
        label={t`Members`}
        onQueryChange={setSearch}
        pageSize={pageSize}
        query={search}
        rowKey={(row) => row.key}
        // Someone invited is not here yet: their row fades toward its end.
        // Someone removed is greyed, their menu kept clear.
        rowStatus={(row) => {
          if (row.kind === "invited") {
            return "pending";
          }
          return row.kind === "removed" ? "removed" : undefined;
        }}
        rows={rows}
        unit={{ one: t`person`, other: t`people` }}
      />
    </SectionCard>
  );
};

/**
 * Settings › Members and roles on one page: the people, with what each
 * role may do over them, then (for the organization's own admins) their
 * teams.
 */
const MembersPage = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  return (
    <div {...stylex.props(styles.page)}>
      {page.state === "ready" ? (
        <>
          <PeopleTable
            invitations={page.data.invitations}
            me={identity.userId}
            members={page.data.members}
            removed={page.data.removed}
          />
          <Guests guests={page.data.guests} />
        </>
      ) : (
        <SectionCard variant="grouped" density="compact" title={t`Members`}>
          <SectionNotLoaded page={page} />
        </SectionCard>
      )}
      {/* Nothing before a read was tried, or for anyone core refuses it. */}
      <DirectoryReads />
      {/* Core refuses the teams to anyone else. */}
      {/* Read again whenever the people change, so a removed person leaves the teams' faces too. */}
      {isMemberAdmin(identity) ? (
        <TeamsPanel
          key={
            page.state === "ready"
              ? page.data.members.map(({ userId }) => userId).join(" ")
              : "unread"
          }
        />
      ) : null}
    </div>
  );
};

const ignoreNotice = (): void => undefined;

/**
 * The people's card while they are read: the card as the loaded one
 * stands (its title waiting, its head's actions in place), holding the library's page-skeleton-table
 * without its header, the table waiting in its own `loading` with the
 * columns, label and page size it will have (the name's column a
 * person's placeholder), so its head and rows stand where they will.
 */
const MembersPending = () => {
  const { t } = useLingui();
  const words = usePeopleWords();
  const narrow = useNarrow();
  return (
    <SectionCard
      actions={
        // Roles and Invite need no data, so they stand as they will; the
        // search waits as its field's empty frame, in the search's box.
        <>
          <RolesButton />
          <div {...stylex.props(styles.search)}>
            <PageSkeletonToolbar variant="search" />
          </div>
          <InviteButton />
        </>
      }
      density="compact"
      flush
      loading
      title=""
      variant="grouped"
    >
      <PageSkeletonTable<PersonRow>
        header={false}
        table={{
          columns: peopleColumns({
            words,
            me: "",
            narrow,
            onNotice: ignoreNotice,
          }),
          label: t`Members`,
          pageSize,
          unit: { one: t`person`, other: t`people` },
        }}
      />
    </SectionCard>
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
