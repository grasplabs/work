import { failureText } from "@grasp-os/shared/errors";
import { memberErrors } from "@grasp-os/shared/members";
import type { Invitation, Member } from "@grasp-os/shared/members";
import { roleSchema } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { formatList } from "../format.ts";
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
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import {
  Icon,
  Minus,
  More,
  Search,
  SignOut,
  Tick,
  Trash,
} from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemActions,
} from "../grasp/item/index.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
} from "../grasp/select/index.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../grasp/table/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { roleLabel } from "../labels.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { RemovedPeople } from "../settings/erasures.tsx";
import { InvitationRow, InviteButton } from "../settings/invitations.tsx";
import { MembersTabs } from "../settings/members-tabs.tsx";
import {
  SectionNotLoaded,
  SettingsError,
  SettingsLoading,
  TitleLine,
} from "../settings/section.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// Settings → Members and roles, for admins: the organization's members,
// each with their role, a way to end their sessions, and a way to remove
// them for good; the invitations nobody has taken up yet; then the people
// removed, and a way to erase them (settings/erasures.tsx); and, last,
// what each role may do. Core checks the role on every call; anyone else
// sees why they can't. The admin's own row has no actions: core refuses
// removing yourself or ending your own sessions, and demoting yourself
// (which core allows while another admin exists) is left out so nobody
// loses this page by accident.

// Wide enough for the longest role in every language.
const roleWidth = "8rem";

const styles = stylex.create({
  tools: { display: "flex", alignItems: "center", gap: grasp.space2 },
  // Narrower on a phone: Section card's actions never shrink, so Invite would run past its edge.
  search: { width: { default: "14rem", [media.belowPhone]: "8rem" } },
  notice: { padding: grasp.space4 },
  rowEnd: { display: "flex", alignItems: "center", gap: grasp.space1 },
  role: { width: roleWidth },
  // Your own row has no menu: its role sits where the others' Selects start.
  own: {
    display: "flex",
    width: `calc(${roleWidth} + ${grasp.space1} + ${grasp.controlSm})`,
  },
  rolesNarrow: {
    display: { default: "none", [media.belowPhone]: "block" },
    padding: grasp.space5,
  },
  rolesWide: { display: { default: "block", [media.belowPhone]: "none" } },
});

/** The roles to pick from, in the page's language. */
const roleItems = (): { label: string; value: Role }[] =>
  roleSchema.options.map((role) => ({ label: roleLabel(role), value: role }));

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
  const remove = async (): Promise<void> => {
    onNotice({});
    try {
      const { connectionsDisconnected: count } = await core.withSession(
        async ({ members }) => await members.remove(member.userId)
      );
      onNotice({
        done: t`${name} is removed. ${plural(count, { one: "# personal connection was disconnected.", other: "# personal connections were disconnected." })}`,
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
      <div {...stylex.props(styles.role)}>
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
          <SelectTrigger size="sm" aria-label={t`Role of ${who}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent />
        </Select>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          icon={More}
          aria-label={t`Actions for ${who}`}
          size="sm"
          variant="ghost"
        />
        <DropdownMenuContent align="end">
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

/**
 * What each role may do in Grasp, as core allows it (`@grasp-os/shared/roles`
 * and the calls that check it): everyone uses what is shared with them;
 * builders build; admins decide who does what.
 */
const capabilities: { label: MessageDescriptor; roles: Role[] }[] = [
  {
    label: msg`Use the chat, Knowledge and the Apps shared with them`,
    roles: ["admin", "builder", "user"],
  },
  {
    label: msg`Connect accounts of their own`,
    roles: ["admin", "builder", "user"],
  },
  {
    label: msg`Build Apps and workflows, and ask for the permissions they need`,
    roles: ["admin", "builder"],
  },
  {
    label: msg`Connect shared accounts and decide what Apps may do`,
    roles: ["admin"],
  },
  {
    label: msg`See the models, AI spend and the audit trail`,
    roles: ["admin"],
  },
  {
    label: msg`Invite people, change roles, sign them out and remove them`,
    roles: ["admin"],
  },
];

/** What each role may do: a column a role, a tick where it may. */
const Roles = () => {
  const { t, i18n } = useLingui();
  const roles = roleSchema.options;
  return (
    <SectionCard flush title={t`Roles`}>
      {/* On a phone, what each may do with the roles that may under it: four columns don't fit. */}
      <div {...stylex.props(styles.rolesNarrow)}>
        <KeyValueList
          items={capabilities.map((capability) => ({
            key: i18n._(capability.label),
            value: formatList(capability.roles.map((role) => roleLabel(role))),
          }))}
        />
      </div>
      <div {...stylex.props(styles.rolesWide)}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {t({
                  message: "May",
                  comment:
                    "Heading of a list of what each role is allowed to do",
                })}
              </TableHead>
              {roles.map((role) => (
                <TableHead align="center" key={role}>
                  {roleLabel(role)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {capabilities.map((capability) => (
              <TableRow key={capability.label.id}>
                <TableCell lead>{i18n._(capability.label)}</TableCell>
                {roles.map((role) => (
                  <TableCell align="center" key={role}>
                    {capability.roles.includes(role) ? (
                      <Icon icon={Tick} label={t`Yes`} />
                    ) : (
                      <Icon icon={Minus} label={t`No`} />
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SectionCard>
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

/** The members and the invitations not yet taken up, found by name or email. */
const MembersList = ({
  members,
  invitations,
  me,
}: {
  members: Member[];
  invitations: Invitation[];
  me: string;
}) => {
  const { t } = useLingui();
  const [notice, setNotice] = useState<Notice>({});
  const [search, setSearch] = useState("");
  const searchField = useRef<HTMLInputElement>(null);
  const people = members.length;
  const shown = members.filter((member) => matches(member, search));
  const invited = invitations.filter((invitation) =>
    matches(invitation, search)
  );
  return (
    <SectionCard
      actions={
        <div {...stylex.props(styles.tools)}>
          <div {...stylex.props(styles.search)}>
            <Input
              aria-label={t`Search members`}
              icon={Search}
              onValueChange={setSearch}
              placeholder={t`Search`}
              ref={searchField}
              size="sm"
              value={search}
            />
          </div>
          <InviteButton />
        </div>
      }
      description={t`${plural(people, {
        one: "# person has access. Invite someone to set their role up front.",
        other:
          "# people have access. Invite someone to set their role up front.",
      })}`}
      flush
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
      {shown.length === 0 && invited.length === 0 ? (
        <div {...stylex.props(styles.notice)}>
          <Text tone="muted">{t`Nobody matches.`}</Text>
        </div>
      ) : (
        <ItemGroup aria-label={t`Members`} separated>
          {shown.map((member) => (
            <Item key={member.userId} size="sm">
              <ItemContent>
                <ItemTitle>
                  <TitleLine detail={member.email}>
                    {member.name}
                    {member.userId === me ? (
                      <Badge size="sm">{t`You`}</Badge>
                    ) : null}
                  </TitleLine>
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                {member.userId === me ? (
                  <div {...stylex.props(styles.own)}>
                    <Badge>{roleLabel(member.role)}</Badge>
                  </div>
                ) : (
                  <MemberActions
                    member={member}
                    onNotice={setNotice}
                    onRemoved={() => {
                      searchField.current?.focus();
                    }}
                  />
                )}
              </ItemActions>
            </Item>
          ))}
          {invited.map((invitation) => (
            <InvitationRow invitation={invitation} key={invitation.id} />
          ))}
        </ItemGroup>
      )}
    </SectionCard>
  );
};

const Members = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  return page.state === "ready" ? (
    <>
      <MembersList
        invitations={page.data.invitations}
        me={identity.userId}
        members={page.data.members}
      />
      <RemovedPeople page={page.data.removed} />
    </>
  ) : (
    <SectionCard title={t`Members`}>
      <SectionNotLoaded page={page} />
    </SectionCard>
  );
};

/** The members, and for the organization's admins tabs of their teams and of what each role may do. */
const MembersPage = () => (
  <MembersTabs roles={<Roles />}>
    <Members />
  </MembersTabs>
);

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
