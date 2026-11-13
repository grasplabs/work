import type {
  AppMember,
  AppMemberRef,
  AppRole,
  ShareCandidates,
} from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
import type { Subject, SubjectKind } from "@grasp-os/shared/subject";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { useCoreRead } from "../apps/use-core-read.ts";
import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { roleLabel } from "../labels.ts";
import { NotLoaded } from "../load-from-core.tsx";
import { usePeopleApart } from "../people/people-apart.ts";
import type { PeopleApart } from "../people/people-apart.ts";
import { RoleSelect, SharePicker } from "../people/share-picker.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Whom an App or a workflow is shared with besides its owner and the
// admins, as a user or a builder: its Sharing settings, and Share with
// your team (share-with-team.tsx), which adds users alone. Both kinds
// give their members alike (`apps.members`, `workflowResources.members`),
// named by core; whom to share with comes from their `candidates`, the
// organization's people and teams by name, for whoever may share it, as
// a builder isn't an admin and can't list the organization's members.
// Core checks every change and records it in the audit log.

/** Someone it is shared with: a person, a team, or everyone in a project, by name. */
export type Member = AppMember;

/** Whom a subject is shared with, as both kinds give it. */
interface MembersApi {
  list: (id: string) => Promise<Member[]>;
  add: (
    id: string,
    member: AppMemberRef & { role: AppRole }
  ) => Promise<unknown>;
  remove: (id: string, member: AppMemberRef) => Promise<unknown>;
  candidates: (id: string) => Promise<ShareCandidates>;
}

/** The members of `kind`'s subjects, over `session`. */
export const membersOf = (session: Session, kind: SubjectKind): MembersApi =>
  kind === "app" ? session.apps.members : session.workflowResources.members;

/** Whom `subject` is shared with. */
export const readMembers = async (
  session: Session,
  { kind, id }: Subject
): Promise<Member[]> => await membersOf(session, kind).list(id);

/**
 * Who uses it by name, as its status says it: the teams, people and
 * projects it is shared with, those with a name the person may read.
 */
export const memberNames = (members: readonly Member[]): string[] =>
  members.flatMap(({ name }) => (name === null ? [] : [name]));

/** How a member is named: a team, and everyone in a project, say so. */
interface MemberWords {
  team: (name: string) => string;
  project: (name: string) => string;
  /** A project the viewer isn't in, whose name is its members' alone. */
  unnamedProject: string;
}

/** Who `member` is, in words: a person told apart from a namesake. */
const memberName = (member: Member, words: MemberWords, apart: PeopleApart) => {
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

/**
 * Share: the organization's people and teams it isn't shared with yet,
 * read when it opens, and the role to give whoever is picked.
 */
const ShareMembers = ({
  subject,
  owner,
  members,
  onChanged,
}: {
  subject: Subject;
  owner: string;
  /** Whom it is shared with now, left out of the list. */
  members: readonly AppMemberRef[];
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [candidates, setCandidates] = useState<ShareCandidates>();
  // Everyone in the organization, so someone is told apart from a
  // namesake it is shared with already, or its owner.
  const apart = usePeopleApart(candidates?.people ?? []);
  const shared = new Set(members.map(({ type, id }) => `${type}:${id}`));
  const isOffered = (type: AppMemberRef["type"], id: string): boolean =>
    !shared.has(`${type}:${id}`) && !(type === "person" && id === owner);
  const read = async (): Promise<void> => {
    if (candidates !== undefined) {
      return;
    }
    const listed = await run(
      async (session) =>
        await membersOf(session, subject.kind).candidates(subject.id)
    );
    if (listed !== undefined) {
      setCandidates(listed);
    }
  };
  const share = async (member: AppMemberRef, role: AppRole): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(async () => {
        await membersOf(session, subject.kind).add(subject.id, {
          ...member,
          role,
        });
      }, onChanged);
    });
  };
  const offered =
    candidates === undefined
      ? undefined
      : {
          people: candidates.people.filter(({ id }) => isOffered("person", id)),
          teams: candidates.teams.filter(({ id }) => isOffered("team", id)),
          // Only the projects the person builds: sharing with one reaches
          // everyone in it, which its builders decide.
          projects: candidates.projects.filter(({ id }) =>
            isOffered("project", id)
          ),
        };
  return (
    <div className="flex flex-col items-end gap-1">
      <SharePicker
        disabled={busy}
        failure={failure}
        empty={<Trans>Nobody else to share with.</Trans>}
        hintOf={apart.hint}
        offered={offered}
        onOpen={() => {
          void read();
        }}
        onPick={(member, role) => {
          void share(member, role);
        }}
        roleHeading={<Trans>Share as</Trans>}
        roleName={t`Role to share with`}
      >
        {/* Its icon alone where its bar is narrow (frame/item-shell.tsx). */}
        <span className="@max-4xl/bar:sr-only">
          <Trans>Share</Trans>
        </span>
      </SharePicker>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** Someone it is shared with: their role, and unsharing, for its builders. */
const MemberRow = ({
  subject,
  member,
  editable,
  apart,
  onChanged,
}: {
  subject: Subject;
  member: Member;
  editable: boolean;
  /** Telling apart the people it is shared with of the same name. */
  apart: PeopleApart;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const name = memberName(
    member,
    {
      team: (team) => t`${team} (team)`,
      project: (project) => t`Everyone in ${project}`,
      unnamedProject: t`Everyone in a project you aren’t in`,
    },
    apart
  );
  const ref: AppMemberRef = { type: member.type, id: member.id };
  const change = async (
    action: (members: MembersApi) => Promise<unknown>
  ): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(async () => {
        await action(membersOf(session, subject.kind));
      }, onChanged);
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
                async (members) =>
                  await members.add(subject.id, { ...ref, role })
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
                    Their open pages of it stop within seconds, and they can no
                    longer open it. You can share it with them again.
                  </Trans>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Trans>Cancel</Trans>
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    void change(async (members) => {
                      await members.remove(subject.id, ref);
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
 * Sharing, in an App's or a workflow's settings: who opens it, its owner
 * and the admins, who build it, and the people, teams and projects it is
 * shared with, each as a user or a builder, read again after each change
 * made here. Whoever may change it (`editable`) shares it, changes a role
 * and unshares it.
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
  const router = useRouter();
  // Each change made here, which reads whom it is shared with again.
  const [changes, setChanges] = useState(0);
  const read = useCoreRead(
    `${subject.kind}:${subject.id}/${changes}`,
    async (session) => await readMembers(session, subject),
    subject.id
  );
  const members = read?.state === "ready" ? read.data : [];
  const apart = usePeopleApart(
    members.flatMap(({ type, id, name }) =>
      type === "person" && name !== null ? [{ id, name }] : []
    )
  );
  const onChanged = async (): Promise<void> => {
    setChanges((before) => before + 1);
    // Whoever sees it now, as the page reads it.
    await router.invalidate({ sync: true });
  };
  if (read?.state !== "ready") {
    return read === undefined ? null : <NotLoaded page={read} />;
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-muted-foreground">
          {owner === identity.userId
            ? t`Created by you. It opens for you, the admins, and whoever it is shared with.`
            : t`It opens for the member who created it, the admins, and whoever it is shared with.`}
        </p>
        {editable ? (
          <ShareMembers
            members={members}
            onChanged={onChanged}
            owner={owner}
            subject={subject}
          />
        ) : null}
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
                  apart={apart}
                  editable={editable}
                  key={`${member.type}:${member.id}`}
                  member={member}
                  onChanged={onChanged}
                  subject={subject}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
};
