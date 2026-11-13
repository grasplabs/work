import type {
  WorkflowMember,
  WorkflowResource,
  WorkflowRole,
  WorkflowShareCandidates,
} from "@grasp-os/shared/workflow-resources";
import { Button } from "@grasp-os/ui/components/button";
import { Label } from "@grasp-os/ui/components/label";
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { useCoreRead } from "../apps/use-core-read.ts";
import { ErrorText } from "../error-text.tsx";
import { roleLabel } from "../labels.ts";
import { NotLoaded } from "../load-from-core.tsx";
import { usePeopleApart } from "../people/people-apart.ts";
import { useCoreAction } from "../use-core-action.ts";

// Sharing an independent workflow (GRA-1304): whom it is open to besides
// its owner and the admins, as a user (it follows and starts it) or a
// builder (it also publishes, shares and deletes it). Its builders share
// it in its Settings' Sharing, change a role and unshare it, as an App's
// do; Share with your team, in its bar, adds users alone. Whom to share
// with comes from `workflowResources.shareCandidates`: the organization's
// people and teams by name, for whoever may share the workflow, as a
// builder isn't an admin and can't list the organization's members. Core
// checks every change (a builder of the workflow, never Grasp staff, a
// builder's role only to someone whose organization role builds, never
// the owner) and records it in the audit log; what it refuses is said in
// the dialog.

const roles: readonly WorkflowRole[] = ["user", "builder"];

/** `value` as a role, if it is one. */
const roleOf = (value: string): WorkflowRole | undefined =>
  roles.find((each) => each === value);

/** A member as the dialog names it, from the people and teams it read. */
const nameOf = (
  member: Pick<WorkflowMember, "type" | "id">,
  candidates: WorkflowShareCandidates
): string =>
  (member.type === "person" ? candidates.people : candidates.teams).find(
    ({ id }) => id === member.id
  )?.name ?? member.id;

/** The kinds of member the dialog shares with, by their value's prefix. */
const memberTypes = ["person", "team", "project"] as const;

/** A role to choose, labelled in the page's language. */
const RoleSelect = ({
  id,
  label,
  role,
  disabled,
  onChange,
}: {
  id?: string;
  label?: string;
  role: WorkflowRole;
  disabled?: boolean;
  onChange: (role: WorkflowRole) => void;
}) => (
  <NativeSelect
    aria-label={label}
    disabled={disabled}
    id={id}
    onChange={(event) => {
      const chosen = roleOf(event.target.value);
      if (chosen !== undefined) {
        onChange(chosen);
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
);

/** What the dialog read: whom to share with, and whom it is shared with. */
interface Read {
  candidates: WorkflowShareCandidates;
  members: WorkflowMember[];
}

/**
 * Whom to offer: the people (not its owner), teams and projects it isn't
 * shared with yet; none while they are read.
 */
const offeredOf = (
  read: Read | undefined,
  owner: string
): WorkflowShareCandidates => {
  if (read === undefined) {
    return { people: [], teams: [], projects: [] };
  }
  const shared = new Set(read.members.map(({ type, id }) => `${type}:${id}`));
  return {
    people: read.candidates.people.filter(
      ({ id }) => id !== owner && !shared.has(`person:${id}`)
    ),
    teams: read.candidates.teams.filter(({ id }) => !shared.has(`team:${id}`)),
    // Only the projects the person builds: sharing with one reaches
    // everyone in it, which its builders decide.
    projects: read.candidates.projects.filter(
      ({ id }) => !shared.has(`project:${id}`)
    ),
  };
};

/** Whom it is shared with, each with their role, and unsharing them. */
const SharedWith = ({
  read,
  busy,
  onChange,
}: {
  read: Read;
  busy: boolean;
  /** Changes a member's role, or unshares them (null). */
  onChange: (
    member: Pick<WorkflowMember, "type" | "id">,
    as: WorkflowRole | null
  ) => Promise<void>;
}) => {
  const { t } = useLingui();
  const everyone = (project: string): string => t`Everyone in ${project}`;
  // Told apart among themselves, as an App's list is.
  const sharedApart = usePeopleApart(
    read.members.flatMap((member) =>
      member.type === "person"
        ? [{ id: member.id, name: nameOf(member, read.candidates) }]
        : []
    )
  );
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-muted-foreground">
        <Trans>Shared with</Trans>
      </h3>
      {read.members.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans context="a workflow">It isn&apos;t shared with anyone.</Trans>
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {read.members.map((member) => {
            const memberName = nameOf(member, read.candidates);
            const projectName = member.projectName ?? null;
            let shown = memberName;
            if (member.type === "person") {
              shown = sharedApart.named({
                id: member.id,
                name: memberName,
              });
            } else if (member.type === "team") {
              shown = t`${memberName} (team)`;
            } else if (member.type === "project") {
              shown =
                projectName === null
                  ? t`Everyone in a project you aren’t in`
                  : everyone(projectName);
            }
            return (
              <li
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                key={`${member.type}:${member.id}`}
              >
                <span className="min-w-0 truncate">{shown}</span>
                <span className="flex items-center gap-2">
                  <RoleSelect
                    disabled={busy}
                    label={t`Role of ${shown}`}
                    onChange={(next) => {
                      void onChange(member, next);
                    }}
                    role={member.role}
                  />
                  <Button
                    aria-label={t`Stop sharing with ${shown}`}
                    disabled={busy}
                    onClick={() => {
                      void onChange(member, null);
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    <Trans>Unshare</Trans>
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

/** Sharing, in workflow `resource`'s settings, for its builders. */
export const ShareWorkflow = ({
  resource,
}: {
  resource: Pick<WorkflowResource, "id" | "owner">;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  // Each change made here, which reads whom it is shared with again.
  const [changes, setChanges] = useState(0);
  const loaded = useCoreRead(
    `${resource.id}/${changes}`,
    async (session): Promise<Read> => {
      const [candidates, members] = await Promise.all([
        session.workflowResources.shareCandidates(resource.id),
        session.workflowResources.members(resource.id),
      ]);
      return { candidates, members };
    },
    resource.id
  );
  const read = loaded?.state === "ready" ? loaded.data : undefined;
  const [chosen, setChosen] = useState("");
  const [role, setRole] = useState<WorkflowRole>("user");
  const everyone = (project: string): string => t`Everyone in ${project}`;
  const workflow = resource.id;
  // Whom to share with: told apart among everyone in the organization,
  // so from a namesake it is shared with already too.
  const apart = usePeopleApart(read?.candidates.people ?? []);

  /** Shares with `member` in `as`, or unshares them, then reads again. */
  const change = async (
    member: Pick<WorkflowMember, "type" | "id">,
    as: WorkflowRole | null
  ): Promise<void> => {
    const ref = { type: member.type, id: member.id };
    const done = await run(async (session) => {
      await (as === null
        ? session.workflowResources.unshare(workflow, ref)
        : session.workflowResources.share(workflow, { ...ref, role: as }));
      return true;
    });
    if (done === true) {
      setChosen("");
      setChanges((before) => before + 1);
      // Whoever sees it now, as the page reads it.
      void router.invalidate();
    }
  };

  const { people, teams, projects } = offeredOf(read, resource.owner);
  const [chosenPrefix, chosenId] = chosen.split(":", 2);
  const chosenType = memberTypes.find((type) => type === chosenPrefix);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground">
        <Trans>
          Its owner and the admins always have it. A user follows and starts it;
          a builder also changes, shares and deletes it.
        </Trans>
      </p>
      {read === undefined ? null : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (chosenType !== undefined && chosenId !== undefined) {
              void change({ type: chosenType, id: chosenId }, role);
            }
          }}
        >
          <Label htmlFor={`${ids}-who`}>
            <Trans>Share with</Trans>
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect
              id={`${ids}-who`}
              onChange={(event) => {
                setChosen(event.target.value);
              }}
              value={chosen}
            >
              <NativeSelectOption value="">{t`Choose…`}</NativeSelectOption>
              {people.length === 0 ? null : (
                <NativeSelectOptGroup label={t`People`}>
                  {people.map((person) => (
                    <NativeSelectOption
                      key={person.id}
                      value={`person:${person.id}`}
                    >
                      {apart.named(person)}
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
              {projects.length === 0 ? null : (
                <NativeSelectOptGroup label={t`Projects`}>
                  {projects.map((project) => (
                    <NativeSelectOption
                      key={project.id}
                      value={`project:${project.id}`}
                    >
                      {everyone(project.name)}
                    </NativeSelectOption>
                  ))}
                </NativeSelectOptGroup>
              )}
            </NativeSelect>
            <RoleSelect
              label={t`Role to share with`}
              onChange={setRole}
              role={role}
            />
            <Button disabled={busy || chosen === ""} size="sm" type="submit">
              <Trans context="share a workflow with someone">Share</Trans>
            </Button>
          </div>
        </form>
      )}
      <ErrorText>{failure}</ErrorText>
      {loaded === undefined || loaded.state === "ready" ? null : (
        <NotLoaded page={loaded} />
      )}
      {read === undefined ? null : (
        <SharedWith busy={busy} onChange={change} read={read} />
      )}
    </div>
  );
};
