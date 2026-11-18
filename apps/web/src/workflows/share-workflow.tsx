import type {
  WorkflowMember,
  WorkflowResource,
  WorkflowRole,
  WorkflowShareCandidates,
} from "@grasp-os/shared/workflow-resources";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { Avatar, AvatarFallback } from "../grasp/avatar/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "../grasp/dialog/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { People, Projects, UserAdd } from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import type { SelectItems } from "../grasp/select/index.ts";
import { Text } from "../grasp/text/index.ts";
import { toast } from "../grasp/toast/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { roleLabel } from "../labels.ts";
import { usePeopleApart } from "../people/people-apart.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

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

/** The kinds of member the dialog shares with, by their value's prefix. */
const memberTypes = ["person", "team", "project"] as const;

/** The width of the workflow's bar under which Share shows its icon alone (frame/item-shell.tsx). */
const narrowBar = "@container bar (width < 64rem)";

const styles = stylex.create({
  // Its words, hidden from the eye where the bar is narrow, still its name.
  barWords: {
    position: { default: null, [narrowBar]: "absolute" },
    width: { default: null, [narrowBar]: 1 },
    height: { default: null, [narrowBar]: 1 },
    overflow: { default: null, [narrowBar]: "hidden" },
    clipPath: { default: null, [narrowBar]: "inset(50%)" },
    whiteSpace: { default: null, [narrowBar]: "nowrap" },
  },
  body: { display: "grid", rowGap: grasp.space5 },
  form: { display: "grid", rowGap: grasp.space2 },
  pick: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
  },
  who: { flexGrow: 1, minWidth: "12rem" },
  shared: { display: "grid", rowGap: grasp.space2 },
  memberEnd: { display: "flex", alignItems: "center", gap: grasp.space2 },
});

/** A role to choose, labelled in the page's language. */
const RoleSelect = ({
  label,
  role,
  disabled,
  onChange,
}: {
  label: string;
  role: WorkflowRole;
  disabled?: boolean;
  onChange: (role: WorkflowRole) => void;
}) => (
  <Select
    disabled={disabled}
    items={roles.map((each) => ({ value: each, label: roleLabel(each) }))}
    onValueChange={(value) => {
      const chosen = value === null ? undefined : roleOf(value);
      if (chosen !== undefined) {
        onChange(chosen);
      }
    }}
    value={role}
  >
    <SelectTrigger aria-label={label} size="sm">
      <SelectValue />
    </SelectTrigger>
    <SelectContent />
  </Select>
);

/** A member's face or mark, at the start of its row. */
const MemberMark = ({
  member,
  name,
}: {
  member: Pick<WorkflowMember, "type">;
  name: string;
}) => {
  if (member.type === "person") {
    return (
      <ItemMedia>
        <Avatar decorative name={name} size="xs">
          <AvatarFallback />
        </Avatar>
      </ItemMedia>
    );
  }
  return (
    <ItemMedia
      icon={member.type === "team" ? People : Projects}
      iconLook="inline"
    />
  );
};

/** A group of the Share with list, left out while it has nobody. */
const groupOf = (
  label: string,
  items: { value: string; label: string }[]
): SelectItems =>
  items.length === 0 ? [] : [{ type: "group" as const, label, items }];

/** How a member is named in the list of whom it is shared with. */
const useShownName = () => {
  const { t } = useLingui();
  return (
    member: WorkflowMember,
    memberName: string,
    named: (person: { id: string; name: string }) => string
  ): string => {
    if (member.type === "person") {
      return named({ id: member.id, name: memberName });
    }
    if (member.type === "team") {
      return t`${memberName} (team)`;
    }
    const project = member.projectName ?? null;
    return project === null
      ? t`Everyone in a project you aren’t in`
      : t`Everyone in ${project}`;
  };
};

/** One member it is shared with: their name, their role, and Unshare. */
const MemberRow = ({
  member,
  memberName,
  shown,
  busy,
  onChange,
}: {
  member: WorkflowMember;
  memberName: string;
  shown: string;
  busy: boolean;
  onChange: (as: WorkflowRole | null) => void;
}) => {
  const { t } = useLingui();
  return (
    <Item size="xs">
      <MemberMark member={member} name={memberName} />
      <ItemContent>
        <ItemTitle>{shown}</ItemTitle>
      </ItemContent>
      <ItemActions>
        <span {...stylex.props(styles.memberEnd)}>
          <RoleSelect
            disabled={busy}
            label={t`Role of ${shown}`}
            onChange={onChange}
            role={member.role}
          />
          <Button
            aria-label={t`Stop sharing with ${shown}`}
            disabled={busy}
            onClick={() => {
              onChange(null);
            }}
            size="sm"
            variant="ghost"
          >
            {t`Unshare`}
          </Button>
        </span>
      </ItemActions>
    </Item>
  );
};

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
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<Read>();
  const [chosen, setChosen] = useState("");
  const [role, setRole] = useState<WorkflowRole>("user");
  const everyone = (project: string): string => t`Everyone in ${project}`;
  const shownName = useShownName();
  const workflow = resource.id;
  const { name } = resource;
  // Whom to share with: told apart among everyone in the organization,
  // so from a namesake it is shared with already too. Whom it is shared
  // with: among themselves, as an App's list is.
  const apart = usePeopleApart(read?.candidates.people ?? []);
  const sharedApart = usePeopleApart(
    read === undefined
      ? []
      : read.members.flatMap((member) =>
          member.type === "person"
            ? [{ id: member.id, name: nameOf(member, read.candidates) }]
            : []
        )
  );

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
  ): Promise<boolean> => {
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
    return done === true;
  };

  /**
   * Changes `member`'s role; stopping a share acts at once and offers Undo
   * in a toast, which shares it again in the role it had, by the same call.
   */
  const changeMember = async (
    member: WorkflowMember,
    as: WorkflowRole | null,
    memberName: string
  ): Promise<void> => {
    const done = await change(member, as);
    if (!done || as !== null) {
      return;
    }
    toast.success(t`Stopped sharing with ${memberName}`, {
      action: {
        label: t`Undo`,
        onAction: () => {
          void change(member, member.role);
        },
      },
    });
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
  // Only the projects the person builds: sharing with one reaches everyone
  // in it, which its builders decide.
  const projects = (read?.candidates.projects ?? []).filter(
    ({ id }) => !shared.has(`project:${id}`)
  );
  const [chosenPrefix, chosenId] = chosen.split(":", 2);
  const chosenType = memberTypes.find((type) => type === chosenPrefix);
  const candidates: SelectItems = [
    ...groupOf(
      t`People`,
      people.map((person) => ({
        value: `person:${person.id}`,
        label: apart.named(person),
      }))
    ),
    ...groupOf(
      t`Teams`,
      teams.map((team) => ({ value: `team:${team.id}`, label: team.name }))
    ),
    ...groupOf(
      t`Projects`,
      projects.map((project) => ({
        value: `project:${project.id}`,
        label: everyone(project.name),
      }))
    ),
  ];

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
      <DialogTrigger icon={UserAdd} size="sm">
        <span {...stylex.props(styles.barWords)}>{t`Share`}</span>
      </DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Share ${name}`}</DialogTitle>
        <DialogDescription>
          {t`Its owner and the admins always have it. A user follows and starts it; a builder also changes, shares and deletes it.`}
        </DialogDescription>
        <DialogBody>
          <div {...stylex.props(styles.body)}>
            {read === undefined ? null : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (chosenType !== undefined && chosenId !== undefined) {
                    void change({ type: chosenType, id: chosenId }, role);
                  }
                }}
                {...stylex.props(styles.form)}
              >
                <Field>
                  <FieldLabel>{t`Share with`}</FieldLabel>
                  <div {...stylex.props(styles.pick)}>
                    <Select
                      items={candidates}
                      onValueChange={(value) => {
                        setChosen(value ?? "");
                      }}
                      value={chosen === "" ? null : chosen}
                    >
                      <SelectTrigger layout={styles.who} size="sm">
                        <SelectValue placeholder={t`Choose…`} />
                      </SelectTrigger>
                      <SelectContent />
                    </Select>
                    <RoleSelect
                      label={t`Role to share with`}
                      onChange={setRole}
                      role={role}
                    />
                    <Button
                      disabled={busy || chosen === ""}
                      size="sm"
                      type="submit"
                      variant="ink"
                    >
                      {t({
                        message: "Share",
                        context: "share a workflow with someone",
                      })}
                    </Button>
                  </div>
                </Field>
              </form>
            )}
            <ErrorText>{failure}</ErrorText>
            {read === undefined ? null : (
              <section {...stylex.props(styles.shared)}>
                <Text size="sm" tone="muted" weight="medium">
                  {t`Shared with`}
                </Text>
                {read.members.length === 0 ? (
                  <Text size="sm" tone="muted">
                    {t({
                      message: "It isn't shared with anyone.",
                      context: "a workflow",
                    })}
                  </Text>
                ) : (
                  <ItemGroup aria-label={t`Shared with`} separated>
                    {read.members.map((member) => {
                      const memberName = nameOf(member, read.candidates);
                      return (
                        <MemberRow
                          busy={busy}
                          key={`${member.type}:${member.id}`}
                          member={member}
                          memberName={memberName}
                          onChange={(as) => {
                            void changeMember(member, as, memberName);
                          }}
                          shown={shownName(
                            member,
                            memberName,
                            sharedApart.named
                          )}
                        />
                      );
                    })}
                  </ItemGroup>
                )}
              </section>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogAction>{t`Close`}</DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Whom workflow `workflow` is shared with, by name, for one who builds
 * it (`builds`), who may read whom to share with: what its status says
 * it runs for. None while read, refused, or for anyone else.
 */
export const useWorkflowUsers = (
  workflow: string,
  builds: boolean
): string[] | undefined => {
  const core = useCore();
  const [read, setRead] = useState<{ workflow: string; names: string[] }>();
  useEffect(() => {
    if (!builds) {
      return () => {
        // Nothing was read.
      };
    }
    let current = true;
    const load = async (): Promise<void> => {
      try {
        const names = await core.withSession(async (session) => {
          const [candidates, members] = await Promise.all([
            session.workflowResources.shareCandidates(workflow),
            session.workflowResources.members(workflow),
          ]);
          return members.flatMap((member) => {
            if (member.type !== "project") {
              return [nameOf(member, candidates)];
            }
            return member.projectName === null ||
              member.projectName === undefined
              ? []
              : [member.projectName];
          });
        });
        if (current) {
          setRead({ workflow, names });
        }
      } catch {
        // Its status says it runs for the team, without names.
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [core, workflow, builds]);
  return read?.workflow === workflow ? read.names : undefined;
};
