import type {
  Project,
  ProjectMember,
  ProjectRole,
  ProjectShareCandidates,
} from "@grasp-os/shared/projects";
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
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { roleLabel } from "../labels.ts";
import { useCoreAction } from "../use-core-action.ts";

// Who is in a project: its owner, who always builds it, and the people and
// teams in it, each a user (sees it) or a builder (also changes it). Being
// in a project reaches only what is shared with it. Its builders add and
// take people out; taking someone out confirms that they lose what is
// shared with the project.

const roles: readonly ProjectRole[] = ["user", "builder"];

/** `value` as a role, if it is one. */
const roleOf = (value: string): ProjectRole | undefined =>
  roles.find((each) => each === value);

/** A member as listed: a team says so. */
const useMemberName = () => {
  const { t } = useLingui();
  return (member: ProjectMember): string => {
    const name = member.name ?? member.id;
    return member.type === "team" ? t`${name} (team)` : name;
  };
};

/** Adding a person or team, for the project's builders. */
const AddPerson = ({ project }: { project: Project }) => {
  const { t } = useLingui();
  const ids = useId();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [candidates, setCandidates] = useState<ProjectShareCandidates>();
  const [chosen, setChosen] = useState("");
  const [role, setRole] = useState<ProjectRole>("user");
  const inIt = new Set([
    `person:${project.owner.id}`,
    ...project.members.map(({ type, id }) => `${type}:${id}`),
  ]);
  const read = async (): Promise<void> => {
    if (candidates !== undefined) {
      return;
    }
    const listed = await run(
      async (session) => await session.projects.shareCandidates(project.id)
    );
    setCandidates(listed);
  };
  const [chosenType, chosenId] = chosen.split(":", 2);
  const add = async (): Promise<void> => {
    if (
      (chosenType !== "person" && chosenType !== "team") ||
      chosenId === undefined ||
      chosenId === ""
    ) {
      return;
    }
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await session.projects.addMember(project.id, {
            type: chosenType,
            id: chosenId,
            role,
          });
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
    setChosen("");
  };
  const people = (candidates?.people ?? []).filter(
    ({ id }) => !inIt.has(`person:${id}`)
  );
  const teams = (candidates?.teams ?? []).filter(
    ({ id }) => !inIt.has(`team:${id}`)
  );
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          aria-label={t`Person or team to add`}
          id={`${ids}-who`}
          onChange={(event) => {
            setChosen(event.target.value);
          }}
          onFocus={() => {
            void read();
          }}
          size="sm"
          value={chosen}
        >
          <NativeSelectOption value="">{t`Add someone…`}</NativeSelectOption>
          {people.length === 0 ? null : (
            <NativeSelectOptGroup label={t`People`}>
              {people.map((person) => (
                <NativeSelectOption
                  key={person.id}
                  value={`person:${person.id}`}
                >
                  {person.name}
                </NativeSelectOption>
              ))}
            </NativeSelectOptGroup>
          )}
          {teams.length === 0 ? null : (
            <NativeSelectOptGroup label={t`Teams`}>
              {teams.map((team) => (
                <NativeSelectOption key={team.id} value={`team:${team.id}`}>
                  {team.name}
                </NativeSelectOption>
              ))}
            </NativeSelectOptGroup>
          )}
        </NativeSelect>
        <NativeSelect
          aria-label={t`Role in the project`}
          onChange={(event) => {
            const next = roleOf(event.target.value);
            if (next !== undefined) {
              setRole(next);
            }
          }}
          size="sm"
          value={role}
        >
          {roles.map((each) => (
            <NativeSelectOption key={each} value={each}>
              {roleLabel(each)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button disabled={busy || chosen === ""} size="sm" type="submit">
          <Trans context="add someone to a project">Add</Trans>
        </Button>
      </div>
      <ErrorText>{failure}</ErrorText>
    </form>
  );
};

/** Taking someone out, after naming what they lose. */
const RemovePerson = ({
  project,
  member,
}: {
  project: Project;
  member: ProjectMember;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const nameOf = useMemberName();
  const name = nameOf(member);
  const projectName = project.name;
  const shared = project.items.filter(({ sharedAs }) => sharedAs !== null);
  return (
    <>
      <AlertDialog>
        <AlertDialogTrigger
          disabled={busy}
          render={
            <Button
              aria-label={t`Take ${name} out of the project`}
              size="sm"
              variant="ghost"
            />
          }
        >
          <Trans context="take out of a project">Remove</Trans>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>
                Take {name} out of {projectName}?
              </Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {shared.length === 0 ? (
                <Trans>
                  Nothing is shared with the project, so they lose no access.
                </Trans>
              ) : (
                <Trans>
                  They lose access to what is shared with everyone in the
                  project, unless it is also shared with them another way. Their
                  open screens of it stop within seconds.
                </Trans>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void run(async (session) => {
                  await changeThenRefresh(
                    async () => {
                      await session.projects.removeMember(project.id, {
                        type: member.type,
                        id: member.id,
                      });
                    },
                    async () => {
                      await router.invalidate({ sync: true });
                    }
                  );
                });
              }}
              variant="destructive"
            >
              <Trans>Take out</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ErrorText>{failure}</ErrorText>
    </>
  );
};

/** The project's people, and for its builders adding and taking them out. */
export const ProjectPeople = ({ project }: { project: Project }) => {
  const nameOf = useMemberName();
  const builds = project.role === "builder";
  const owner = project.owner.name ?? project.owner.id;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y rounded-md border">
        <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <span className="min-w-0 truncate">{owner}</span>
          <span className="text-muted-foreground">
            <Trans context="a project's owner">Owner</Trans>
          </span>
        </li>
        {project.members.map((member) => (
          <li
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
            key={`${member.type}:${member.id}`}
          >
            <span className="min-w-0 truncate">{nameOf(member)}</span>
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">
                {roleLabel(member.role)}
              </span>
              {builds ? (
                <RemovePerson member={member} project={project} />
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {builds ? <AddPerson project={project} /> : null}
    </div>
  );
};
