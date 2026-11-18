import type {
  Project,
  ProjectMember,
  ProjectMemberRef,
  ProjectRole,
  ProjectShareCandidates,
} from "@grasp-os/shared/projects";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { useAppRead } from "../apps/use-app-read.ts";
import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
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
import { Button } from "../grasp/button/index.ts";
import { Icon, People } from "../grasp/icons/index.ts";
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
import type { Named, PeopleApart } from "../people/people-apart.ts";
import { matchTyped } from "../people/person-picker.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { usePages } from "./project-pages.ts";

// Who is in a project: its owner, who always builds it, and the people and
// teams in it, each a user (sees it) or a builder (also changes it), on
// Grasp UI's Share access. Being in a project reaches only what is shared
// with it. Its builders add people and teams (several at once, from whom
// core offers), change their role at the row's end and take them out;
// taking someone out first names what they lose. Everyone else in it sees
// the list alone.

const styles = stylex.create({
  section: { display: "flex", flexDirection: "column", gap: grasp.space3 },
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
        <Icon icon={People} />
      ) : (
        <Avatar decorative name={name} size="xs" />
      )}
    </ItemMedia>
    <ItemContent>
      <ItemTitle>{name}</ItemTitle>
    </ItemContent>
    <ItemActions>
      <Text element="span" size="sm" tone="muted">
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
  const [query, setQuery] = useState("");
  const [removing, setRemoving] = useState<ProjectMember>();
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
  // Found by what was typed in a name (or what tells a namesake apart),
  // never in an ID: the list is the page's, so it can say while it is read.
  const found = candidates.filter(
    (candidate) =>
      matchTyped(candidate.name, query, [
        candidate.name,
        candidate.note ?? "",
      ]) > 0
  );
  const gone = removing === undefined ? "" : named(removing);
  const projectName = project.name;
  return (
    <>
      <ShareAccess
        candidates={found}
        failedInviteLabel={t`Not added`}
        filter={false}
        findLabel={t`Search people and teams`}
        inviteLevelLabel={t`Role in the project`}
        levels={roles.map((role) => ({ value: role, label: roleLabel(role) }))}
        loading={offered === undefined}
        members={[
          {
            id: keyOf({ type: "person", id: project.owner.id }),
            name: ownerName,
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
          const refs = picked.ids.flatMap((id) => {
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
        onQueryChange={setQuery}
        onRemove={(id) => {
          setRemoving(members.find((member) => keyOf(member) === id));
        }}
        ownerLabel={t({ message: "Owner", context: "a project's owner" })}
        query={query}
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
          <AlertDialogTitle>{t`Take ${gone} out of ${projectName}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {project.shared === 0
              ? t`Nothing is shared with the project, so they lose no access.`
              : t`They lose access to what is shared with everyone in the project, unless it is also shared with them another way. Their open pages of it stop within seconds.`}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
            <AlertDialogAction
              action={async () => {
                if (removing === undefined) {
                  return;
                }
                const ref: ProjectMemberRef = {
                  type: removing.type,
                  id: removing.id,
                };
                const done = await change(async (session) => {
                  await session.projects.removeMember(project.id, ref);
                });
                if (!done) {
                  // The dialog stays open, and core's reason shows under the list.
                  throw new Error("They weren't taken out.");
                }
              }}
              failedLabel={t`Not taken out`}
              variant="danger"
              workingLabel={t`Taking out`}
            >
              {t`Take out`}
            </AlertDialogAction>
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
        <ItemGroup aria-label={t`People`} separated>
          <MemberRow
            name={owner}
            role={t({ message: "Owner", context: "a project's owner" })}
            team={false}
          />
          {pages.all.map((member) => (
            <MemberRow
              key={keyOf(member)}
              name={nameOf(member)}
              role={roleLabel(member.role)}
              team={member.type === "team"}
            />
          ))}
        </ItemGroup>
      )}
      {pages.more ? (
        <Button
          disabled={pages.busy}
          onClick={() => {
            void pages.readMore();
          }}
          size="sm"
          variant="quiet"
        >
          {t`Show more`}
        </Button>
      ) : null}
      <ErrorText>{pages.failure}</ErrorText>
    </div>
  );
};
