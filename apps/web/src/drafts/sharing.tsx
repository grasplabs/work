import type { Identity } from "@grasp-os/shared/rpc";
import type { Subject, SubjectKind } from "@grasp-os/shared/subject";
import type {
  MemberRole,
  ShareCandidates,
  SubjectMember,
  SubjectMemberRef,
  SubjectMembersApi,
} from "@grasp-os/shared/subject-members";
import { Alert, AlertTitle } from "@grasp-os/ui/components/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Button } from "@grasp-os/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Text } from "@grasp-os/ui/components/text";
import { FolderIcon, Icon, UsersIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { Fragment, useState } from "react";

import { useCoreRead } from "../apps/use-core-read.ts";
import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { roleLabel } from "../labels.ts";
import type { Loaded } from "../load-from-core.tsx";
import { usePeopleApart } from "../people/people-apart.ts";
import type { PeopleApart } from "../people/people-apart.ts";
import { useCoreAction } from "../use-core-action.ts";
import { ShareAccess } from "./share-access.tsx";
import type { ShareCandidate } from "./share-access.tsx";

// Whom an App or a workflow is shared with besides its owner and the
// admins, as a user or a builder: its Sharing settings, and Share in its
// bar (share-with-team.tsx), on Share access (share-access.tsx): each member with
// their role at the row's end, and a picker of the people, teams and
// projects core offers to add. Taking someone off asks
// first. Both kinds give their members alike (`apps.members`,
// `workflowResources.members`), named by core; whom to share with comes
// from their `candidates`, the organization's people and teams by name,
// for whoever may share it, as a builder isn't an admin and can't list the
// organization's members. Core checks every change and records it in the
// audit log.

/** The members of `kind`'s subjects, over `session`. */
const membersOf = (session: Session, kind: SubjectKind): SubjectMembersApi =>
  kind === "app" ? session.apps.members : session.workflowResources.members;

/** Whom `subject` is shared with. */
const readMembers = async (
  session: Session,
  { kind, id }: Subject
): Promise<SubjectMember[]> => await membersOf(session, kind).list(id);

/**
 * The read of whom `subject` is shared with, read again each time it is
 * shared from the page (`shares`, one more each time), the last one held
 * while it is; none to read without a subject (someone it isn't read
 * for). Undefined only until the first read lands, failed or not.
 */
export const useMembersRead = (
  subject: Subject | undefined,
  shares = 0
): Loaded<SubjectMember[]> | undefined => {
  const scope =
    subject === undefined ? "none" : `${subject.kind}:${subject.id}`;
  return useCoreRead(
    `${scope}/${shares}`,
    async (session) =>
      subject === undefined ? [] : await readMembers(session, subject),
    scope
  );
};

/**
 * Whom `subject` is shared with (`useMembersRead`): undefined while it is
 * read, or when it couldn't be.
 */
export const useMembers = (
  subject: Subject | undefined,
  shares = 0
): readonly SubjectMember[] | undefined => {
  const read = useMembersRead(subject, shares);
  return read?.state === "ready" ? read.data : undefined;
};

/**
 * Who uses it by name, as its status says it: the teams, people and
 * projects it is shared with, those with a name the person may read.
 */
export const memberNames = (members: readonly SubjectMember[]): string[] =>
  members.flatMap(({ name }) => (name === null ? [] : [name]));

/** How a member is named: a team, and everyone in a project, say so. */
interface MemberWords {
  team: (name: string) => string;
  project: (name: string) => string;
  /** A project the viewer isn't in, whose name is its members' alone. */
  unnamedProject: string;
  /** Marks a guest, someone from outside the company, wherever they are listed. */
  guest: string;
}

/** Who `member` is, in words: a person told apart from a namesake. */
const memberName = (
  member: SubjectMember,
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

const styles = stylex.create({
  section: { display: "flex", flexDirection: "column", gap: space[3] },
});

/** The roles to give, from least to most. */
const roles: readonly MemberRole[] = ["user", "builder"];

/** Whom a member is: a person's face, or a team's or project's mark. */
const Mark = ({
  type,
  name,
}: {
  type: SubjectMemberRef["type"];
  name: string;
}) => {
  if (type === "person") {
    return (
      <Avatar decorative name={name} size="xs">
        <AvatarFallback />
      </Avatar>
    );
  }
  return <Icon icon={type === "team" ? UsersIcon : FolderIcon} />;
};

/** The words that say a member's kind, in the page's language. */
const useMemberWords = (): MemberWords => {
  const { t } = useLingui();
  return {
    team: (team) => t`${team} (team)`,
    project: (project) => t`Everyone in ${project}`,
    unnamedProject: t`Everyone in a project you aren’t in`,
    guest: t`Guest`,
  };
};

/** A member's or a candidate's key: its kind and its ID, as Share access knows them. */
const keyOf = ({ type, id }: SubjectMemberRef): string => `${type}:${id}`;

/** The member a key names, back from Share access. */
const refOf = (key: string): SubjectMemberRef | undefined => {
  const [type, ...rest] = key.split(":");
  const id = rest.join(":");
  return type === "person" || type === "team" || type === "project"
    ? { type, id }
    : undefined;
};

/** Everyone it can be shared with, as Share access offers them. */
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
      const note = person.guest === true ? words.guest : apart.hint(person);
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

/** Someone it is shared with, for whoever only looks: their name and role. */
const MemberRow = ({
  name,
  member,
}: {
  name: string;
  member: SubjectMember;
}) => (
  <Item size="sm">
    <ItemMedia>
      <Mark name={member.name ?? name} type={member.type} />
    </ItemMedia>
    <ItemContent>
      <ItemTitle>{name}</ItemTitle>
    </ItemContent>
    <ItemActions>
      <Text as="span" color="muted" size="sm">
        {roleLabel(member.role)}
      </Text>
    </ItemActions>
  </Item>
);

/**
 * Sharing, for its builders, on Share access: who it is shared with at
 * which role, a role to change at each row's end, and a picker of the
 * organization's people, teams and projects to add.
 * Taking someone off asks first.
 */
const ShareWith = ({
  subject,
  owner,
  members,
  named,
  onChanged,
}: {
  subject: Subject;
  /** Its owner, who always opens it and isn't offered. */
  owner: string;
  members: readonly SubjectMember[];
  named: (member: SubjectMember) => string;
  /** Told once whom it is shared with changed. */
  onChanged: () => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const words = useMemberWords();
  const { failure, run } = useCoreAction();
  const scope = `${subject.kind}:${subject.id}`;
  const offered = useCoreRead(
    scope,
    async (session) =>
      await membersOf(session, subject.kind).candidates(subject.id),
    scope
  );
  const [removing, setRemoving] = useState<SubjectMember>();
  // Everyone in the organization, so someone is told apart from a
  // namesake it is shared with already, or its owner.
  const apart = usePeopleApart(
    offered?.state === "ready" ? offered.data.people : []
  );
  const change = async (
    action: (members: SubjectMembersApi) => Promise<unknown>
  ): Promise<boolean> => {
    let done = false;
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await action(membersOf(session, subject.kind));
          done = true;
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
    if (done) {
      onChanged();
    }
    return done;
  };
  const gone = removing === undefined ? "" : named(removing);
  return (
    <>
      <ShareAccess
        candidates={
          offered?.state === "ready"
            ? candidatesOf(offered.data, owner, apart, words)
            : []
        }
        failedLabel={t`Couldn't share`}
        levels={roles.map((role) => ({ value: role, label: roleLabel(role) }))}
        listLabel={t`Shared with`}
        members={members.map((member) => ({
          id: keyOf(member),
          name: named(member),
          ...(member.guest === true ? { note: words.guest } : {}),
          kind: member.type === "team" ? ("group" as const) : member.type,
          level: member.role,
        }))}
        onAdd={async (ids, level) => {
          const role = roles.find((each) => each === level) ?? "user";
          const refs = ids.flatMap((id) => {
            const ref = refOf(id);
            return ref === undefined ? [] : [ref];
          });
          const done = await change(async (api) => {
            for (const ref of refs) {
              // oxlint-disable-next-line no-await-in-loop -- one share at a time, in the order picked
              await api.add(subject.id, { ...ref, role });
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
              async (api) => await api.add(subject.id, { ...ref, role })
            );
          }
        }}
        onRemove={(id) => {
          setRemoving(members.find((member) => keyOf(member) === id));
        }}
      />
      {offered !== undefined && offered.state !== "ready" ? (
        <Alert variant="destructive">
          <AlertTitle>{t`Who to share with couldn't be read. Try again in a moment.`}</AlertTitle>
        </Alert>
      ) : null}
      {failure === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>{failure}</AlertTitle>
        </Alert>
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
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Stop sharing with ${gone}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`Their open pages of it stop within seconds, and they can no longer open it. You can share it with them again.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel />
            <Button
              size="sm"
              errorText={t`Couldn't stop sharing`}
              onClick={async () => {
                if (removing === undefined) {
                  return;
                }
                const ref: SubjectMemberRef = {
                  type: removing.type,
                  id: removing.id,
                };
                const done = await change(async (api) => {
                  await api.remove(subject.id, ref);
                });
                if (!done) {
                  throw new Error("Still shared.");
                }
                setRemoving(undefined);
              }}
              variant="destructive"
            >
              {t`Stop sharing`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

/** Names its members, each person told apart from a namesake among them. */
const useNamed = (
  members: readonly SubjectMember[]
): ((member: SubjectMember) => string) => {
  const words = useMemberWords();
  const apart = usePeopleApart(
    members.flatMap(({ type, id, name }) =>
      type === "person" && name !== null ? [{ id, name }] : []
    )
  );
  return (member) => memberName(member, words, apart);
};

/**
 * Sharing it, as Share's dialog in its bar holds it (share-with-team.tsx):
 * the same list as its Sharing settings, on whom it is shared with as the
 * bar read it (`members`). For its builders.
 */
export const ShareMembersAccess = ({
  subject,
  owner,
  members,
  onChanged,
}: {
  subject: Subject;
  owner: string;
  members: readonly SubjectMember[];
  /** Told once whom it is shared with changed, to read it again. */
  onChanged: () => void;
}) => {
  const named = useNamed(members);
  return (
    <ShareWith
      members={members}
      named={named}
      onChanged={onChanged}
      owner={owner}
      subject={subject}
    />
  );
};

/**
 * Sharing, in an App's or a workflow's settings: who opens it, its owner
 * and the admins, who build it, and the people, teams and projects it is
 * shared with, each as a user or a builder, read again after each change
 * made here. Whoever may change it (`editable`) shares it, changes a role
 * and unshares it; everyone else only sees with whom.
 */
export const Sharing = ({
  subject,
  owner,
  editable,
  identity,
}: {
  subject: Subject;
  owner: string;
  editable: boolean;
  identity: Pick<Identity, "userId">;
}) => {
  const { t } = useLingui();
  // Each change made here, which reads whom it is shared with again.
  const [changes, setChanges] = useState(0);
  const read = useCoreRead(
    `${subject.kind}:${subject.id}/${changes}`,
    async (session) => await readMembers(session, subject),
    subject.id
  );
  const members = read?.state === "ready" ? read.data : [];
  const named = useNamed(members);
  if (read?.state !== "ready") {
    return read === undefined ? null : (
      <NotLoadedState
        again={() => {
          setChanges(changes + 1);
        }}
        heading="h3"
        page={read}
      />
    );
  }
  return (
    <div {...stylex.props(styles.section)}>
      <Text color="muted" size="sm">
        {owner === identity.userId
          ? t`Created by you. It opens for you, the admins, and whoever it is shared with.`
          : t`It opens for the member who created it, the admins, and whoever it is shared with.`}
      </Text>
      {editable ? (
        <ShareWith
          members={members}
          named={named}
          onChanged={() => {
            setChanges((before) => before + 1);
          }}
          owner={owner}
          subject={subject}
        />
      ) : null}
      {members.length === 0 ? (
        <Text color="muted" size="sm">
          {t`It isn’t shared with anyone.`}
        </Text>
      ) : null}
      {!editable && members.length > 0 ? (
        <ItemGroup aria-label={t`Shared with`}>
          {members.map((member, at) => (
            <Fragment key={keyOf(member)}>
              {at === 0 ? null : <ItemSeparator />}
              <MemberRow member={member} name={named(member)} />
            </Fragment>
          ))}
        </ItemGroup>
      ) : null}
    </div>
  );
};
