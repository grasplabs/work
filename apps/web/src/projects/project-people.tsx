import type {
  Project,
  ProjectMember,
  ProjectRole,
  ProjectShareCandidates,
} from "@grasp-os/shared/projects";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Minus } from "../grasp/icons/index.ts";
import { roleLabel } from "../labels.ts";
import { usePeopleApart } from "../people/people-apart.ts";
import type { Named, PeopleApart } from "../people/people-apart.ts";
import { SharePicker } from "../people/share-picker.tsx";
import type { Picked } from "../people/share-picker.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { usePages } from "./project-pages.ts";

// Who is in a project: its owner, who always builds it, and the people and
// teams in it, each a user (sees it) or a builder (also changes it). Being
// in a project reaches only what is shared with it. Its builders add and
// take people out; taking someone out confirms that they lose what is
// shared with the project.

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

/**
 * Adding a person or team, for the project's builders. `known` is who is
 * in it, read so far, whom someone offered is told apart from too.
 */
const AddPerson = ({
  project,
  known,
}: {
  project: Project;
  known: readonly Named[];
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  // Read for one reading of the project: once it is read again (after an
  // add or a removal), whom to offer is read again too. Core offers only
  // who isn't in it yet, its owner included.
  const [offered, setOffered] = useState<{
    from: Project;
    list: ProjectShareCandidates;
  }>();
  const candidates = offered?.from === project ? offered.list : undefined;
  const apart = usePeopleApart([...known, ...(candidates?.people ?? [])]);
  const read = async (): Promise<void> => {
    if (candidates !== undefined) {
      return;
    }
    const listed = await run(
      async (session) => await session.projects.shareCandidates(project.id)
    );
    if (listed !== undefined) {
      setOffered({ from: project, list: listed });
    }
  };
  const add = async (picked: Picked, role: ProjectRole): Promise<void> => {
    const { type, id } = picked;
    if (type === "project") {
      return;
    }
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await session.projects.addMember(project.id, { type, id, role });
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <div className="flex flex-col gap-1">
      <div>
        <SharePicker
          disabled={busy}
          failure={failure}
          empty={<Trans>Nobody else to add.</Trans>}
          hintOf={apart.hint}
          offered={candidates}
          onOpen={() => {
            void read();
          }}
          onPick={(picked, role) => {
            void add(picked, role);
          }}
          roleHeading={<Trans>Add as</Trans>}
          roleName={t`Role in the project`}
        >
          <Trans>Add someone</Trans>
        </SharePicker>
      </div>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** Taking someone out, after naming what they lose. */
const RemovePerson = ({
  project,
  member,
  name,
}: {
  project: Project;
  member: ProjectMember;
  /** As the list names them. */
  name: string;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { failure, run } = useCoreAction();
  const projectName = project.name;
  const takeOut = async (): Promise<void> => {
    const done = await run(async (session) => {
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
      return true;
    });
    if (done !== true) {
      // The dialog stays open, and core's reason shows under the row.
      throw new Error("They weren't taken out.");
    }
  };
  return (
    <>
      <AlertDialog>
        <AlertDialogTrigger
          aria-label={t`Take ${name} out of the project`}
          icon={Minus}
          size="sm"
          variant="ghost"
        >
          {t({ message: "Remove", context: "take out of a project" })}
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>{t`Take ${name} out of ${projectName}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {project.shared === 0
              ? t`Nothing is shared with the project, so they lose no access.`
              : t`They lose access to what is shared with everyone in the project, unless it is also shared with them another way. Their open pages of it stop within seconds.`}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
            <AlertDialogAction
              action={takeOut}
              failedLabel={t`Couldn't take it out`}
              variant="danger"
              workingLabel={t`Taking it out`}
            >
              {t`Take out`}
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
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y rounded-md border">
        <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <span className="min-w-0 truncate">{owner}</span>
          <span className="text-muted-foreground">
            <Trans context="a project's owner">Owner</Trans>
          </span>
        </li>
        {pages.all.map((member) => (
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
                <RemovePerson
                  member={member}
                  name={nameOf(member)}
                  project={project}
                />
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {pages.more ? (
        <Button
          disabled={pages.busy}
          onClick={() => {
            void pages.readMore();
          }}
          size="sm"
          variant="quiet"
        >
          <Trans>Show more</Trans>
        </Button>
      ) : null}
      <ErrorText>{pages.failure}</ErrorText>
      {builds ? <AddPerson known={known} project={project} /> : null}
    </div>
  );
};
