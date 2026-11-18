import { failureText } from "@grasp-os/shared/errors";
import { memberErrors } from "@grasp-os/shared/members";
import type {
  Invitation,
  Member,
  RemovedPeoplePage,
} from "@grasp-os/shared/members";
import { isMemberAdmin, roleSchema } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogContent,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Avatar, AvatarFallback } from "../grasp/avatar/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../grasp/empty/index.ts";
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
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemRevealButton,
  ItemTitle,
} from "../grasp/item/index.ts";
import { Pagination } from "../grasp/pagination/index.ts";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../grasp/popover/index.ts";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
} from "../grasp/select/index.ts";
import { SettingsRows } from "../grasp/setting-row/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { roleLabel } from "../labels.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { RemovedRow, useRemovedPeople } from "../settings/erasures.tsx";
import {
  copyEmail,
  InvitationRow,
  InviteButton,
} from "../settings/invitations.tsx";
import { roleItems, roleLines } from "../settings/roles.ts";
import {
  SectionNotLoaded,
  SettingsError,
  SettingsLoading,
} from "../settings/section.tsx";
import { TeamsPanel } from "../settings/teams.tsx";
import { TitledCard } from "../settings/titled-card.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// Settings → Members and roles, on one page as the library's Settings
// pattern has it: one compact card of people, each with their face, their
// email, their role on one edge and a menu to end their sessions or remove
// them for good; the invitations nobody has taken up yet; and at its foot
// the people removed, quiet, and a way to erase them
// (settings/erasures.tsx). Then the teams, for the organization's own
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
  // Your own row has no menu: its room is kept, so every role stands on one edge.
  menuRoom: { width: grasp.controlXs, flexShrink: 0 },
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

/** How many people a page of the list holds: the rest are a page further. */
const pageSize = 20;

/** One row of the people's list: a member, or an invitation not yet taken up. */
type Listed =
  | { kind: "member"; member: Member }
  | { kind: "invited"; invitation: Invitation };

/** What a change did, or why it failed. */
interface Notice {
  failure?: string;
  done?: string;
}

/** A member's role and the menu of what else may be done to them. */
const MemberActions = ({
  member,
  onNotice,
  onRemoved,
}: {
  member: Member;
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
        <SelectTrigger aria-label={t`Role of ${who}`} size="sm" variant="text">
          <SelectValue />
        </SelectTrigger>
        <SelectContent />
      </Select>
      <DropdownMenu>
        {/* Off while a role change is sent and the list read again, as the
            role is: nothing acts on a row that is about to change. */}
        <DropdownMenuTrigger
          disabled={busy}
          icon={More}
          aria-label={t`Actions for ${who}`}
          size="xs"
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

/** Whether `person` is what the search names: in their name or email. */
const matches = (
  person: { name?: string; email: string },
  search: string
): boolean => {
  const words = search.trim().toLocaleLowerCase();
  return (
    words === "" ||
    (person.name ?? "").toLocaleLowerCase().includes(words) ||
    person.email.toLocaleLowerCase().includes(words)
  );
};

/**
 * One's own role, which one doesn't change here (core allows it while
 * another admin exists, but nobody should lose this page by accident): on
 * the same edge as the others', with the room their menu takes.
 */
const OwnRole = ({ role }: { role: Role }) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.rowEnd)}>
      <Select disabled items={roleItems()} value={role}>
        <SelectTrigger aria-label={t`Your role`} size="sm" variant="text">
          <SelectValue />
        </SelectTrigger>
        <SelectContent />
      </Select>
      <span {...stylex.props(styles.menuRoom)} />
    </div>
  );
};

/** One member: their face, their name (a quiet "You" on one's own), their email, their role and their menu. */
const MemberRow = ({
  member,
  me,
  onNotice,
  onRemoved,
}: {
  member: Member;
  me: boolean;
  onNotice: (notice: Notice) => void;
  onRemoved: () => void;
}) => {
  const { t } = useLingui();
  const { name } = member;
  return (
    <Item size="xs">
      <ItemMedia align="center">
        <Avatar decorative name={member.name} size="xs">
          <AvatarFallback />
        </Avatar>
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {member.name}
          {me ? <ItemDetail>{t`You`}</ItemDetail> : null}
        </ItemTitle>
        <ItemDescription>
          {member.email}
          <ItemRevealButton
            aria-label={t`Copy email of ${name}`}
            icon={Copy}
            onClick={() => {
              void copyEmail(member.email, {
                copied: t`Copied`,
                failed: t`Copying didn't work`,
              });
            }}
          />
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {me ? (
          <OwnRole role={member.role} />
        ) : (
          <MemberActions
            member={member}
            onNotice={onNotice}
            onRemoved={onRemoved}
          />
        )}
      </ItemActions>
    </Item>
  );
};

/**
 * The members, the invitations not yet taken up and, at the foot, the
 * people removed, in one list found by name or email.
 */
const MembersList = ({
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
  const searchField = useRef<HTMLInputElement>(null);
  const gone = useRemovedPeople(removed);
  const [page, setPage] = useState(1);
  // The people and the invitations not yet taken up, as one list.
  const everyone = members.length + invitations.length;
  const found: Listed[] = [
    ...members
      .filter((member) => matches(member, search))
      .map((member) => ({ kind: "member" as const, member })),
    ...invitations
      .filter((invitation) => matches(invitation, search))
      .map((invitation) => ({ kind: "invited" as const, invitation })),
  ];
  // Paged twenty at a time; the search runs over all of them.
  const pages = Math.max(1, Math.ceil(found.length / pageSize));
  const at = Math.min(page, pages);
  const onPage = found.slice((at - 1) * pageSize, at * pageSize);
  const left = gone.people.filter((person) =>
    matches({ name: person.name, email: person.email ?? "" }, search)
  );
  const nobody = found.length === 0 && left.length === 0;
  return (
    <TitledCard
      actions={
        <>
          <RolesButton />
          <InputGroup layout={styles.search}>
            <InputGroupText icon={Search} />
            <InputGroupInput
              aria-label={t`Search members`}
              onValueChange={(value) => {
                setSearch(value);
                setPage(1);
              }}
              placeholder={t`Search members`}
              ref={searchField}
              type="search"
              value={search}
            />
          </InputGroup>
          <InviteButton />
        </>
      }
      density="compact"
      flush
      footer={
        found.length > pageSize ? (
          <Pagination
            aria-label={t`Pages of members`}
            onPageChange={setPage}
            page={at}
            pageSize={pageSize}
            total={found.length}
            unit={{ one: t`person`, other: t`people` }}
          />
        ) : undefined
      }
      title={plural(everyone, { one: "# person", other: "# people" })}
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
      {nobody ? (
        <Empty size="sm">
          <EmptyHeader>
            <EmptyTitle>{t`No one matches`}</EmptyTitle>
            <EmptyDescription>
              {t`Search finds people by their name or email.`}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup aria-label={t`Members`} separated>
          {onPage.map((each) =>
            each.kind === "member" ? (
              <MemberRow
                key={each.member.userId}
                me={each.member.userId === me}
                member={each.member}
                onNotice={setNotice}
                onRemoved={() => {
                  searchField.current?.focus();
                }}
              />
            ) : (
              <InvitationRow
                invitation={each.invitation}
                key={each.invitation.id}
              />
            )
          )}
        </ItemGroup>
      )}
      {/* Removed people: the list's foot, under a quiet name, a step back. */}
      {/* At the list's foot: on its last page only. */}
      {left.length === 0 || at < pages ? null : (
        <SettingsRows label={t`Removed`}>
          <ItemGroup separated>
            {left.map((person) => (
              <RemovedRow key={person.userId} person={person} />
            ))}
          </ItemGroup>
          {gone.more ? (
            <div {...stylex.props(styles.older)}>
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
            </div>
          ) : null}
        </SettingsRows>
      )}
    </TitledCard>
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
        <MembersList
          invitations={page.data.invitations}
          me={identity.userId}
          members={page.data.members}
          removed={page.data.removed}
        />
      ) : (
        <TitledCard density="compact" title={t`Members`}>
          <SectionNotLoaded page={page} />
        </TitledCard>
      )}
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

export const Route = createFileRoute("/_shell/settings/members")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: MembersPage,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => {
      const [members, invitations, removed] = await Promise.all([
        session.members.list(),
        session.members.invitations(),
        session.members.removed(),
      ]);
      return { members, invitations, removed };
    }),
});
