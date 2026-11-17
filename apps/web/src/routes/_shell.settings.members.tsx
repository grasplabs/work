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
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
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
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
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
  // Narrower on a phone: Section card's actions never shrink, so Invite would run past its edge.
  search: { width: { default: "14rem", [media.belowPhone]: "8rem" } },
  notice: { padding: grasp.space4 },
  rowEnd: { display: "flex", alignItems: "center", gap: grasp.space1 },
  // Your own row has no menu: its room is kept, so every role stands on one edge.
  menuRoom: { width: grasp.controlXs, flexShrink: 0 },
  // The roles compared: each name over what it may do.
  roles: {
    display: "grid",
    gap: grasp.space3,
    margin: 0,
    padding: 0,
    maxWidth: "20rem",
  },
  roleName: { margin: 0, fontWeight: grasp.weightMedium, color: grasp.ink },
  roleText: { margin: 0, color: grasp.muted },
  // Removed people: the list's foot, under a quiet name.
  removedLabel: {
    margin: 0,
    paddingBlock: grasp.space2,
    paddingInline: grasp.tableCellInline,
    borderTopStyle: "solid",
    borderTopWidth: grasp.hairline,
    borderTopColor: grasp.line,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    color: grasp.muted,
  },
});

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
        <DropdownMenuTrigger
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
            failedLabel={t`Could not sign out`}
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
              failedLabel={t`Could not make admin`}
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
              failedLabel={t`Could not remove`}
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
      <PopoverTrigger icon={Info} size="sm" variant="ghost">
        {t`Roles`}
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
  const people = members.length;
  const shown = members.filter((member) => matches(member, search));
  const invited = invitations.filter((invitation) =>
    matches(invitation, search)
  );
  const left = gone.people.filter((person) =>
    matches({ name: person.name, email: person.email ?? "" }, search)
  );
  const nobody =
    shown.length === 0 && invited.length === 0 && left.length === 0;
  return (
    <SectionCard
      actions={
        <>
          <RolesButton />
          <InputGroup layout={styles.search}>
            <InputGroupText icon={Search} />
            <InputGroupInput
              aria-label={t`Search members`}
              onValueChange={setSearch}
              placeholder={t`Search members`}
              ref={searchField}
              type="search"
              value={search}
            />
          </InputGroup>
          <InviteButton />
        </>
      }
      aside={<Badge size="sm">{people}</Badge>}
      density="compact"
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
      title={t`Members`}
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
        <div {...stylex.props(styles.notice)}>
          <Text tone="muted">{t`Nobody matches.`}</Text>
        </div>
      ) : (
        <ItemGroup aria-label={t`Members`} separated>
          {shown.map((member) => (
            <MemberRow
              key={member.userId}
              me={member.userId === me}
              member={member}
              onNotice={setNotice}
              onRemoved={() => {
                searchField.current?.focus();
              }}
            />
          ))}
          {invited.map((invitation) => (
            <InvitationRow invitation={invitation} key={invitation.id} />
          ))}
        </ItemGroup>
      )}
      {/* Removed people: the list's foot, under a quiet name, a step back. */}
      {left.length === 0 ? null : (
        <>
          <p {...stylex.props(styles.removedLabel)}>{t`Removed`}</p>
          <ItemGroup aria-label={t`Removed`} separated>
            {left.map((person) => (
              <RemovedRow key={person.userId} person={person} />
            ))}
          </ItemGroup>
        </>
      )}
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
        <MembersList
          invitations={page.data.invitations}
          me={identity.userId}
          members={page.data.members}
          removed={page.data.removed}
        />
      ) : (
        <SectionCard density="compact" title={t`Members`}>
          <SectionNotLoaded page={page} />
        </SectionCard>
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
