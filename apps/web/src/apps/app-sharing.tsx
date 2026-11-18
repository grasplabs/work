import type {
  App,
  AppMember,
  AppMemberRef,
  AppRole,
  ShareCandidates,
  ViewedApp,
} from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Avatar } from "../grasp/avatar/index.ts";
import { Folder, Icon, People } from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { ShareAccess } from "../grasp/share-access/index.ts";
import type { ShareCandidate } from "../grasp/share-access/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { roleLabel } from "../labels.ts";
import { usePeopleApart } from "../people/people-apart.ts";
import type { PeopleApart } from "../people/people-apart.ts";
import { useCoreAction } from "../use-core-action.ts";
import { buildsApp } from "./app-role.ts";
import { useAppRead } from "./use-app-read.ts";

// Sharing an App (an App's): whom it is open to besides its owner and
// the admins, as a user (its pages) or a builder (its code, settings and
// whom it is shared with), in its Settings' Sharing, on Grasp UI's Share
// access: each member with their role at the row's end, and a picker of
// the people, teams and projects core offers to add several at once.
// Taking someone off asks first.
// Its builders share it, change a role and unshare it; everyone with a role
// in it sees whom it is shared with. Whom to share with comes from
// `apps.members.candidates`: the organization's people and teams by name,
// for whoever may share the App, since a builder isn't an admin and can't
// list the organization's members. Core checks every change (a builder of
// the App, not archived, and that everyone it would
// reach may read what the App has read) and records it in the audit log.

/** Whether `identity` may share `app`: a builder of it, while it isn't archived. */
export const sharesApp = (
  app: Pick<App, "archived"> & { role: AppRole },
  identity: Pick<Identity, "staff">
): boolean => buildsApp(app, identity) && !app.archived;

/** How a member is named: a team, and everyone in a project, say so. */
interface MemberWords {
  team: (name: string) => string;
  project: (name: string) => string;
  /** A project the viewer isn't in, whose name is its members' alone. */
  unnamedProject: string;
}

/** Who `member` is, in words: a person told apart from a namesake. */
const memberName = (
  member: AppMember,
  words: MemberWords,
  apart: PeopleApart
) => {
  if (member.type === "project") {
    return member.name === null
      ? words.unnamedProject
      : words.project(member.name);
  }
  const name = member.name ?? member.id;
  return member.type === "team"
    ? words.team(name)
    : apart.named({ id: member.id, name });
};

/** The people and teams App `app` is shared with. */
export const readMembers = async (
  session: Session,
  app: string
): Promise<AppMember[]> => await session.apps.members.list(app);

const styles = stylex.create({
  section: { display: "flex", flexDirection: "column", gap: grasp.space3 },
});

/** The roles to give, from least to most. */
const roles: readonly AppRole[] = ["user", "builder"];

/** Whom a member is: a person's face, or a team's or project's mark. */
const Mark = ({ type, name }: { type: AppMemberRef["type"]; name: string }) => {
  if (type === "person") {
    return <Avatar decorative name={name} size="xs" />;
  }
  return <Icon icon={type === "team" ? People : Folder} />;
};

/** The words that say a member's kind, in the page's language. */
const useMemberWords = (): MemberWords => {
  const { t } = useLingui();
  return {
    team: (team) => t`${team} (team)`,
    project: (project) => t`Everyone in ${project}`,
    unnamedProject: t`Everyone in a project you aren’t in`,
  };
};

/** A member's or a candidate's key: its kind and its ID, as Share access knows them. */
const keyOf = ({ type, id }: AppMemberRef): string => `${type}:${id}`;

/** The member a key names, back from Share access. */
const refOf = (key: string): AppMemberRef | undefined => {
  const [type, ...rest] = key.split(":");
  const id = rest.join(":");
  return type === "person" || type === "team" || type === "project"
    ? { type, id }
    : undefined;
};

/** Who the organization offers to share with: read when Sharing opens, for its builders. */
const readCandidates = async (
  session: Session,
  app: string
): Promise<ShareCandidates> => await session.apps.members.candidates(app);

/** Everyone the App can be shared with, as Share access offers them. */
const candidatesOf = (
  offered: ShareCandidates,
  owner: string,
  apart: PeopleApart,
  words: MemberWords
): ShareCandidate[] => [
  // Never the owner, who always opens it.
  ...offered.people
    .filter(({ id }) => id !== owner)
    .map((person) => {
      const note = apart.hint(person);
      return {
        id: keyOf({ type: "person", id: person.id }),
        name: person.name,
        kind: "person" as const,
        ...(note === undefined ? {} : { note }),
      };
    }),
  ...offered.teams.map((team) => ({
    id: keyOf({ type: "team", id: team.id }),
    name: words.team(team.name),
    kind: "team" as const,
  })),
  // Only the projects the person builds: sharing with one reaches everyone
  // in it, which its builders decide.
  ...offered.projects.map((project) => ({
    id: keyOf({ type: "project", id: project.id }),
    name: words.project(project.name),
    kind: "project" as const,
  })),
];

/** Someone the App is shared with, for whoever only looks: their name and role. */
const MemberRow = ({ name, member }: { name: string; member: AppMember }) => (
  <Item size="sm">
    <ItemMedia>
      <Mark name={member.name ?? name} type={member.type} />
    </ItemMedia>
    <ItemContent>
      <ItemTitle>{name}</ItemTitle>
    </ItemContent>
    <ItemActions>
      <Text element="span" size="sm" tone="muted">
        {roleLabel(member.role)}
      </Text>
    </ItemActions>
  </Item>
);

/**
 * Sharing, for its builders, on Grasp UI's Share access: who it is shared
 * with at which role, a role to change at each row's end, and a picker of
 * the organization's people, teams and projects to add several at once.
 * Taking someone off asks first.
 */
const ShareWith = ({
  app,
  members,
  named,
}: {
  app: App;
  members: readonly AppMember[];
  named: (member: AppMember) => string;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const words = useMemberWords();
  const { failure, run } = useCoreAction();
  const offered = useAppRead(app.id, readCandidates);
  const [removing, setRemoving] = useState<AppMember>();
  // Everyone in the organization, so someone is told apart from a
  // namesake it is shared with already, or its owner.
  const apart = usePeopleApart(
    offered?.state === "ready" ? offered.data.people : []
  );
  const change = async (
    action: (session: Session) => Promise<unknown>
  ): Promise<boolean> => {
    let done = false;
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await action(session);
          done = true;
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
    return done;
  };
  const gone = removing === undefined ? "" : named(removing);
  return (
    <>
      <ShareAccess
        candidates={
          offered?.state === "ready"
            ? candidatesOf(offered.data, app.owner, apart, words)
            : []
        }
        failedInviteLabel={t`Couldn't share`}
        levels={roles.map((role) => ({ value: role, label: roleLabel(role) }))}
        listLabel={t`Shared with`}
        members={members.map((member) => ({
          id: keyOf(member),
          name: named(member),
          kind: member.type === "team" ? "group" : member.type,
          level: member.role,
        }))}
        onAdd={async (picked, level) => {
          const role = roles.find((each) => each === level) ?? "user";
          const refs = picked.ids.flatMap((id) => {
            const ref = refOf(id);
            return ref === undefined ? [] : [ref];
          });
          const done = await change(async (session) => {
            for (const ref of refs) {
              // oxlint-disable-next-line no-await-in-loop -- one share at a time, in the order picked
              await session.apps.members.add(app.id, { ...ref, role });
            }
          });
          if (!done) {
            throw new Error("Not shared.");
          }
        }}
        onLevelChange={(id, level) => {
          const ref = refOf(id);
          const role = roles.find((each) => each === level);
          if (ref !== undefined && role !== undefined) {
            void change(
              async (session) =>
                await session.apps.members.add(app.id, { ...ref, role })
            );
          }
        }}
        onRemove={(id) => {
          setRemoving(members.find((member) => keyOf(member) === id));
        }}
      />
      {offered !== undefined && offered.state !== "ready" ? (
        <Alert
          title={t`Who to share with couldn't be read. Try again in a moment.`}
          variant="danger"
        />
      ) : null}
      {failure === undefined ? null : (
        <Alert title={failure} variant="danger" />
      )}
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(undefined);
          }
        }}
        open={removing !== undefined}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{t`Stop sharing with ${gone}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`Their open pages of it stop within seconds, and they can no longer open it. You can share it with them again.`}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
            <AlertDialogAction
              action={async () => {
                if (removing === undefined) {
                  return;
                }
                const ref: AppMemberRef = {
                  type: removing.type,
                  id: removing.id,
                };
                const done = await change(async (session) => {
                  await session.apps.members.remove(app.id, ref);
                });
                if (!done) {
                  throw new Error("Still shared.");
                }
              }}
              failedLabel={t`Couldn't stop sharing`}
              variant="danger"
            >
              {t`Stop sharing`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

/**
 * Who opens the App: its owner and the admins, who build it, and the
 * people, teams and projects it is shared with, each as a user or a
 * builder. Its builders share it here; everyone else only sees with whom.
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
  const words = useMemberWords();
  const editable = sharesApp(app, identity);
  const apart = usePeopleApart(
    members.flatMap(({ type, id, name }) =>
      type === "person" && name !== null ? [{ id, name }] : []
    )
  );
  const named = (member: AppMember): string => memberName(member, words, apart);
  return (
    <div {...stylex.props(styles.section)}>
      <Text size="sm" tone="muted">
        {app.owner === identity.userId
          ? t`Created by you. It opens for you, the admins, and whoever it is shared with.`
          : t`It opens for the member who created it, the admins, and whoever it is shared with.`}
      </Text>
      {editable ? (
        <ShareWith app={app} members={members} named={named} />
      ) : null}
      {members.length === 0 ? (
        <Text size="sm" tone="muted">
          {t`It isn’t shared with anyone.`}
        </Text>
      ) : null}
      {!editable && members.length > 0 ? (
        <ItemGroup aria-label={t`Shared with`} separated>
          {members.map((member) => (
            <MemberRow
              key={keyOf(member)}
              member={member}
              name={named(member)}
            />
          ))}
        </ItemGroup>
      ) : null}
    </div>
  );
};
