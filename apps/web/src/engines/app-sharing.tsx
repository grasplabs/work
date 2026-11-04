import type {
  App,
  AppMember,
  AppMemberRef,
  AppRole,
  ShareCandidates,
  ViewedApp,
} from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
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

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { roleLabel } from "../labels.ts";
import { RoleSelect, SharePicker } from "../people/share-picker.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { buildsApp } from "./app-role.ts";

// Sharing an App (an App's): whom it is open to besides its owner and
// the admins, as a user (its screens) or a builder (its code, settings and
// whom it is shared with), on its Members tab and from Share on its bar.
// Its builders share it, change a role and unshare it; everyone with a role
// in it sees whom it is shared with. Whom to share with comes from
// `apps.members.candidates`: the organization's people and teams by name,
// for whoever may share the App, since a builder isn't an admin and can't
// list the organization's members. Core checks every change (a builder of
// the App, not archived, and that everyone it would
// reach may read what the App has read) and records it in the audit log.

/** Whether `identity` may share `app`: a builder of it, while it isn't archived. */
export const sharesApp = (
  app: Pick<App, "status"> & { role: AppRole },
  identity: Pick<Identity, "staff">
): boolean => buildsApp(app, identity) && app.status !== "archived";

/** How a member is named: a team, and everyone in a project, say so. */
interface MemberWords {
  team: (name: string) => string;
  project: (name: string) => string;
  /** A project the viewer isn't in, whose name is its members' alone. */
  unnamedProject: string;
}

/** Who `member` is, in words. */
const memberName = (member: AppMember, words: MemberWords) => {
  if (member.type === "project") {
    return member.name === null
      ? words.unnamedProject
      : words.project(member.name);
  }
  const name = member.name ?? member.id;
  return member.type === "team" ? words.team(name) : name;
};

/** The people and teams App `app` is shared with. */
export const readMembers = async (
  session: Session,
  app: string
): Promise<AppMember[]> => await session.apps.members.list(app);

/**
 * Share: the organization's people and teams the App isn't shared with
 * yet, read when it opens, and the role to give whoever is picked.
 */
export const ShareApp = ({
  app,
  members,
}: {
  app: App;
  /** Whom it is shared with now, left out of the list; none while unknown. */
  members: readonly AppMemberRef[];
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [candidates, setCandidates] = useState<ShareCandidates>();
  const shared = new Set(members.map(({ type, id }) => `${type}:${id}`));
  const isOffered = (type: AppMemberRef["type"], id: string): boolean =>
    !shared.has(`${type}:${id}`) && !(type === "person" && id === app.owner);
  const read = async (): Promise<void> => {
    if (candidates !== undefined) {
      return;
    }
    const listed = await run(
      async (session) => await session.apps.members.candidates(app.id)
    );
    if (listed !== undefined) {
      setCandidates(listed);
    }
  };
  const share = async (member: AppMemberRef, role: AppRole): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await session.apps.members.add(app.id, { ...member, role });
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
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
        empty={<Trans>Nobody else to share with.</Trans>}
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
        <Trans>Share</Trans>
      </SharePicker>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** Someone the App is shared with: their role, and unsharing, for its builders. */
const MemberRow = ({
  app,
  member,
  editable,
}: {
  app: App;
  member: AppMember;
  editable: boolean;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const name = memberName(member, {
    team: (team) => t`${team} (team)`,
    project: (project) => t`Everyone in ${project}`,
    unnamedProject: t`Everyone in a project you aren’t in`,
  });
  const ref: AppMemberRef = { type: member.type, id: member.id };
  const change = async (
    action: (
      session: Parameters<Parameters<typeof run>[0]>[0]
    ) => Promise<unknown>
  ): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await action(session);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
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
                async (session) =>
                  await session.apps.members.add(app.id, { ...ref, role })
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
                    Their open screens of it stop within seconds, and they can
                    no longer open it. You can share it with them again.
                  </Trans>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Trans>Cancel</Trans>
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    void change(async (session) => {
                      await session.apps.members.remove(app.id, ref);
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
 * Who opens the App: its owner and the admins, who build it, and the
 * people and teams it is shared with, each as a user or a builder.
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
  const editable = sharesApp(app, identity);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-muted-foreground">
          {app.owner === identity.userId
            ? t`Created by you. It opens for you, the admins, and whoever it is shared with.`
            : t`It opens for the member who created it, the admins, and whoever it is shared with.`}
        </p>
        {editable ? <ShareApp app={app} members={members} /> : null}
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
                  app={app}
                  editable={editable}
                  key={`${member.type}:${member.id}`}
                  member={member}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
};
