import type {
  WorkflowMember,
  WorkflowResource,
  WorkflowRole,
  WorkflowShareCandidates,
} from "@grasp-os/shared/workflow-resources";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import { Label } from "@grasp-os/ui/components/label";
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { UserPlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { roleLabel } from "../labels.ts";
import { useCoreAction } from "../use-core-action.ts";

// Sharing an independent workflow (GRA-1304): whom it is open to besides
// its owner and the admins, as a user (it follows and starts it) or a
// builder (it also publishes, shares and deletes it). Its builders share
// it from Share on its page, change a role and unshare it. Whom to share
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

/** Share on workflow `resource`'s page, for its builders. */
export const ShareWorkflow = ({
  resource,
}: {
  resource: Pick<WorkflowResource, "id" | "name" | "owner" | "role">;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<Read>();
  const [chosen, setChosen] = useState("");
  const [role, setRole] = useState<WorkflowRole>("user");
  const workflow = resource.id;
  const { name } = resource;

  if (resource.role !== "builder") {
    return null;
  }

  const reload = async (): Promise<void> => {
    const both = await run(async (session) => {
      const [candidates, members] = await Promise.all([
        session.workflowResources.shareCandidates(workflow),
        session.workflowResources.members(workflow),
      ]);
      return { candidates, members };
    });
    if (both !== undefined) {
      setRead(both);
    }
  };

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
      await reload();
      // Whoever sees it now, as the page reads it.
      void router.invalidate();
    }
  };

  const shared = new Set(
    (read?.members ?? []).map(({ type, id }) => `${type}:${id}`)
  );
  const people = (read?.candidates.people ?? []).filter(
    ({ id }) => id !== resource.owner && !shared.has(`person:${id}`)
  );
  const teams = (read?.candidates.teams ?? []).filter(
    ({ id }) => !shared.has(`team:${id}`)
  );
  const [chosenType, chosenId] = chosen.split(":", 2);

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          void reload();
        }
      }}
      open={open}
    >
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <UserPlusIcon aria-hidden="true" />
        <Trans>Share</Trans>
      </DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
        <DialogHeader>
          <DialogTitle>
            <Trans>Share {name}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Its owner and the admins always have it. A user follows and starts
              it; a builder also changes, shares and deletes it.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        {read === undefined ? null : (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                (chosenType === "person" || chosenType === "team") &&
                chosenId !== undefined
              ) {
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
                        {person.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelectOptGroup>
                )}
                {teams.length === 0 ? null : (
                  <NativeSelectOptGroup label={t`Teams`}>
                    {teams.map((team) => (
                      <NativeSelectOption
                        key={team.id}
                        value={`team:${team.id}`}
                      >
                        {team.name}
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
        {read === undefined ? null : (
          <section className="flex flex-col gap-2">
            <h3 className="text-muted-foreground">
              <Trans>Shared with</Trans>
            </h3>
            {read.members.length === 0 ? (
              <p className="text-muted-foreground">
                <Trans context="a workflow">
                  It isn&apos;t shared with anyone.
                </Trans>
              </p>
            ) : (
              <ul className="flex flex-col divide-y rounded-md border">
                {read.members.map((member) => {
                  const memberName = nameOf(member, read.candidates);
                  const shown =
                    member.type === "team"
                      ? t`${memberName} (team)`
                      : memberName;
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
                            void change(member, next);
                          }}
                          role={member.role}
                        />
                        <Button
                          aria-label={t`Stop sharing with ${shown}`}
                          disabled={busy}
                          onClick={() => {
                            void change(member, null);
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
        )}
        <DialogFooter closeLabel={t`Close`} showCloseButton />
      </DialogContent>
    </Dialog>
  );
};
