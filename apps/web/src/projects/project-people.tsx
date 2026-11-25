import type {
  Project,
  ProjectMember,
  ProjectMemberRef,
  ProjectRole,
  ProjectShareCandidates,
} from "@grasp-os/shared/projects";
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
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, UsersIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { useAppRead } from "../apps/use-app-read.ts";
import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ShareAccess } from "../drafts/share-access.tsx";
import type { ShareCandidate } from "../drafts/share-access.tsx";
import { ErrorText } from "../error-text.tsx";
import { roleLabel } from "../labels.ts";
import { usePeopleApart } from "../people/people-apart.ts";
import type { Named, PeopleApart } from "../people/people-apart.ts";
import { useCoreAction } from "../use-core-action.ts";
import { SeparatedItems } from "../workflows/separated-items.tsx";
import { usePages } from "./project-pages.ts";

// Who is in a project: its owner, who always builds it, and the people and
// teams in it, each a user (sees it) or a builder (also changes it), on
// the product's Share access (drafts/share-access.tsx). Being in a project
// reaches only what is shared with it. Its builders add people and teams
// (from whom core offers, one at a time on Damsko's Combobox), change their role at the row's end and take them out;
// taking someone out first names what they lose. Everyone else in it sees
// the list alone.

const styles = stylex.create({
  section: { display: "flex", flexDirection: "column", gap: space["3"] },
});

/** The roles to give, from least to most. */
const roles: readonly ProjectRole[] = ["user", "builder"];

/** A member's or a candidate's key: its kind and its ID, as Share access knows them. */
const keyOf = ({ type, id }: ProjectMemberRef): string => `${type}:${id}`;

/** The member a key names, back from Share access. */
const refOf = (key: string): ProjectMemberRef | undefined => {
  const [type, ...rest] = key.split(":");
  const id = rest.join(":");
  return type === "person" || type === "team" ? { type, id } : undefined;
};

/** Whom core offers to add: all but who is in it already, its owner included. */
const readCandidates = async (
  session: Session,
  project: string
): Promise<ProjectShareCandidates> =>
  await session.projects.shareCandidates(project);

/** A member as listed: a team says so, a person is told apart from a namesake. */
const useMemberName = (apart: PeopleApart) => {
  const { t } = useLingui();
  return (member: ProjectMember): string => {
    const name = member.name ?? member.id;
    return member.type === "team"
      ? t`${name} (team)`
      : apart.named({ id: member.id, name });
  };
};

/**
 * The project's people the page has read, its owner first, by name. A
 * namesake on a page of members not read yet isn't among them: reading
 * the next page tells them apart then.
 */
const knownPeople = (
  project: Project,
  members: readonly ProjectMember[]
): Named[] =>
  [project.owner, ...members.filter(({ type }) => type === "person")].flatMap(
    ({ id, name }) => (name === null ? [] : [{ id, name }])
  );

/** Someone in the project, for whoever only looks: their name and role. */
const MemberRow = ({
  name,
  team,
  role,
}: {
  name: string;
  team: boolean;
  role: string;
}) => (
  <Item size="sm">
    <ItemMedia>
      {team ? (
        <Icon icon={UsersIcon} />
      ) : (
        <Avatar decorative name={name} size="xs">
          <AvatarFallback />
        </Avatar>
      )}
    </ItemMedia>
    <ItemContent>
      <ItemTitle>{name}</ItemTitle>
    </ItemContent>
    <ItemActions>
      <Text as="span" size="sm" color="muted">
        {role}
      </Text>
    </ItemActions>
  </Item>
);

/**
 * The project's people for its builders, on Share access: its owner, each
 * member with their role to change, a picker of whom core offers, and
 * taking someone out once they confirm. `known` is who is in it, read so
 * far, whom someone offered is told apart from too.
 */
const ManagePeople = ({
  project,
  members,
  known,
  ownerName,
  named,
}: {
  project: Project;
  members: readonly ProjectMember[];
  known: readonly Named[];
  ownerName: string;
  named: (member: ProjectMember) => string;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { failure, run } = useCoreAction();
  // Read again whenever the project is (after an add, a change or a
  // removal), so who was just added isn't offered again.
  const offered = useAppRead(project.id, readCandidates);
  const [removing, setRemoving] = useState<ProjectMember>();
  const [working, setWorking] = useState(false);
  const people = offered?.state === "ready" ? offered.data.people : [];
  const apart = usePeopleApart([...known, ...people]);
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
  const candidates: ShareCandidate[] =
    offered?.state === "ready"
      ? [
          ...offered.data.people.map((person) => {
            const note = apart.hint(person);
            return {
              id: keyOf({ type: "person", id: person.id }),
              name: person.name,
              kind: "person" as const,
              ...(note === undefined ? {} : { note }),
            };
          }),
          ...offered.data.teams.map((team) => {
            const { name } = team;
            return {
              id: keyOf({ type: "team", id: team.id }),
              name: t`${name} (team)`,
              kind: "team" as const,
            };
          }),
        ]
      : [];
  const gone = removing === undefined ? "" : named(removing);
  const projectName = project.name;
  return (
    <>
      <ShareAccess
        candidates={candidates}
        failedLabel={t`Not added`}
        findLabel={t`Search people and teams`}
        levels={roles.map((role) => ({ value: role, label: roleLabel(role) }))}
        listLabel={t`People`}
        members={[
          {
            id: keyOf({ type: "person", id: project.owner.id }),
            name: ownerName,
            kind: "person" as const,
            owner: true,
          },
          ...members.map((member) => ({
            id: keyOf(member),
            name: named(member),
            kind:
              member.type === "team" ? ("group" as const) : ("person" as const),
            level: member.role,
          })),
        ]}
        onAdd={async (picked, level) => {
          const role = roles.find((each) => each === level) ?? "user";
          const refs = picked.flatMap((id) => {
            const ref = refOf(id);
            return ref === undefined ? [] : [ref];
          });
          const done = await change(async (session) => {
            for (const ref of refs) {
              // oxlint-disable-next-line no-await-in-loop -- one add at a time, in the order picked
              await session.projects.addMember(project.id, { ...ref, role });
            }
          });
          if (!done) {
            throw new Error("Not added.");
          }
        }}
        onLevelChange={(id, level) => {
          const ref = refOf(id);
          const role = roles.find((each) => each === level);
          if (ref !== undefined && role !== undefined) {
            void change(async (session) => {
              await session.projects.addMember(project.id, { ...ref, role });
            });
          }
        }}
        onRemove={(id) => {
          setRemoving(members.find((member) => keyOf(member) === id));
        }}
        ownerLabel={t({ message: "Owner", context: "a project's owner" })}
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
        onOpenChange={(open, details) => {
          // Escape or the shade wait while the taking out runs.
          if (working) {
            details.cancel();
            return;
          }
          if (!open) {
            setRemoving(undefined);
          }
        }}
        open={removing !== undefined}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Take ${gone} out of ${projectName}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {project.shared === 0
                ? t`Nothing is shared with the project, so they lose no access.`
                : t`They lose access to what is shared with everyone in the project, unless it is also shared with them another way. Their open pages of it stop within seconds.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* Why they weren't taken out, in the question the person is in. */}
          <ErrorText>{failure}</ErrorText>
          <AlertDialogFooter>
            <AlertDialogCancel />
            <Button
              errorText={t`Not taken out`}
              loadingText={t`Taking out`}
              onClick={async () => {
                if (removing === undefined) {
                  return;
                }
                const ref: ProjectMemberRef = {
                  type: removing.type,
                  id: removing.id,
                };
                setWorking(true);
                const done = await change(async (session) => {
                  await session.projects.removeMember(project.id, ref);
                }).finally(() => {
                  setWorking(false);
                });
                if (!done) {
                  // The dialog stays open, with core's reason in it.
                  throw new Error("They weren't taken out.");
                }
                setRemoving(undefined);
              }}
              variant="destructive"
            >
              {t`Take out`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

/** The project's people, and for its builders adding, changing and taking them out. */
export const ProjectPeople = ({ project }: { project: Project }) => {
  const { t } = useLingui();
  const pages = usePages(
    project,
    project.members,
    project.moreMembers,
    async (session, after) => {
      const page = await session.projects.members(project.id, after);
      return { list: page.members, more: page.more };
    }
  );
  const builds = project.role === "builder";
  const known = knownPeople(project, pages.all);
  const apart = usePeopleApart(known);
  const nameOf = useMemberName(apart);
  const owner = apart.named({
    id: project.owner.id,
    name: project.owner.name ?? project.owner.id,
  });
  return (
    <div {...stylex.props(styles.section)}>
      {builds ? (
        <ManagePeople
          known={known}
          members={pages.all}
          named={nameOf}
          ownerName={owner}
          project={project}
        />
      ) : (
        <SeparatedItems
          aria-label={t`People`}
          rows={[
            {
              key: "owner",
              row: (
                <MemberRow
                  name={owner}
                  role={t({ message: "Owner", context: "a project's owner" })}
                  team={false}
                />
              ),
            },
            ...pages.all.map((member) => ({
              key: keyOf(member),
              row: (
                <MemberRow
                  name={nameOf(member)}
                  role={roleLabel(member.role)}
                  team={member.type === "team"}
                />
              ),
            })),
          ]}
        />
      )}
      {pages.more ? (
        <Button
          disabled={pages.busy}
          onClick={() => {
            void pages.readMore();
          }}
          size="sm"
          variant="outline"
        >
          {t`Show more`}
        </Button>
      ) : null}
      <ErrorText>{pages.failure}</ErrorText>
    </div>
  );
};
