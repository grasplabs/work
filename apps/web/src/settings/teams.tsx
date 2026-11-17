import type { Member, OrganizationTeam } from "@grasp-os/shared/members";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogPanel,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogFooter,
  DialogPanel,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuPanel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import { Field, FieldError, FieldLabel } from "../grasp/field/index.ts";
import { Form } from "../grasp/form/index.ts";
import { Edit, More, Plus, Trash } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import { Item, ItemGroup } from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Text } from "../grasp/text/index.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import {
  LoadingLines,
  RowNote,
  SectionNotLoaded,
  TitleLine,
} from "./section.tsx";
import { createTeam, deleteTeam, renameTeam } from "./team-changes.ts";
import { TeamMembersDialog } from "./team-members-dialog.tsx";
import { useTeamChange } from "./use-team-change.ts";

// Teams, for admins (GRA-1296): the organization's teams, each with how
// many are in it; making one, renaming it, deleting it, and who is in it.
// Everything that is shared with a team ("Chosen teams") picks from these.
// They aren't the onboarding's roster teams, which are a list of their
// own. Better Auth checks the role on every
// change and core on every read; only admins see this tab at all.

/** What the tab shows: the teams, and the members to put in them. */
interface TeamsData {
  teams: OrganizationTeam[];
  members: Member[];
}

const readTeams = async (
  core: Pick<CoreConnection, "withSession">,
  left?: AbortSignal
): Promise<Loaded<TeamsData>> =>
  await loadFromCore(
    core,
    async (session) => {
      const [teams, members] = await Promise.all([
        session.members.teams(),
        session.members.list(),
      ]);
      return { teams, members };
    },
    left
  );

/** Whether `name` is another team's already, whatever its case. */
const isTaken = (
  name: string,
  teams: readonly OrganizationTeam[],
  except?: string
): boolean => {
  const wanted = name.trim().toLocaleLowerCase();
  return teams.some(
    (team) => team.id !== except && team.name.toLocaleLowerCase() === wanted
  );
};

/** A team's name, asked for in a dialog: for a new team, or a new name. */
const TeamNameDialog = ({
  open,
  onOpenChange,
  title,
  submit,
  initial,
  teams,
  except,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submit: string;
  initial: string;
  teams: readonly OrganizationTeam[];
  /** The team being renamed, which may keep its own name. */
  except?: string;
  /** Saves the name; whether it went through, else why not. */
  onSave: (name: string) => Promise<string | undefined>;
}) => {
  const { t } = useLingui();
  const formId = useId();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const taken = isTaken(name, teams, except);
  const problem = taken ? t`There is a team with this name already.` : failure;
  const save = async (): Promise<void> => {
    if (taken) {
      return;
    }
    setBusy(true);
    const refused = await onSave(name.trim());
    setBusy(false);
    setFailure(refused);
    if (refused === undefined) {
      onOpenChange(false);
    }
  };
  return (
    <Dialog
      onOpenChange={(next) => {
        if (next) {
          setName(initial);
          setFailure(undefined);
        }
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogPanel closeLabel={t`Close`}>
        <DialogTitle>{title}</DialogTitle>
        <DialogBody>
          <Form
            aria-label={title}
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Field invalid={problem !== undefined}>
              <FieldLabel>{t`Name`}</FieldLabel>
              <Input
                autoComplete="off"
                onValueChange={(value) => {
                  setName(value);
                  setFailure(undefined);
                }}
                required
                value={name}
              />
              <FieldError match="valueMissing">{t`Enter a name for the team.`}</FieldError>
              {problem === undefined ? null : (
                <FieldError match>{problem}</FieldError>
              )}
            </Field>
          </Form>
        </DialogBody>
        <DialogFooter>
          <DialogAction>{t`Cancel`}</DialogAction>
          <Button disabled={busy} form={formId} type="submit" variant="ink">
            {submit}
          </Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>
  );
};

/** The New team button, and its dialog. */
const NewTeamButton = ({
  teams,
  onChanged,
}: {
  teams: readonly OrganizationTeam[];
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const { run } = useTeamChange(onChanged);
  return (
    <>
      <Button
        icon={Plus}
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
        variant="ink"
      >
        {t`New team`}
      </Button>
      <TeamNameDialog
        initial=""
        onOpenChange={setOpen}
        onSave={async (name) =>
          await run(
            async () => {
              await createTeam(name);
            },
            t`The team couldn't be created. Try again.`
          )
        }
        open={open}
        submit={t`Create team`}
        teams={teams}
        title={t`New team`}
      />
    </>
  );
};

/** One team: its name, how many are in it, and what an admin does with it. */
const TeamRow = ({
  team,
  teams,
  members,
  onChanged,
}: {
  team: OrganizationTeam;
  teams: readonly OrganizationTeam[];
  members: readonly Member[];
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState<"rename" | "delete" | "members">();
  const { busy, failure, run } = useTeamChange(onChanged);
  const { name } = team;
  const count = team.memberIds.length;
  const close = (next: boolean): void => {
    if (!next) {
      setOpen(undefined);
    }
  };
  const remove = async (): Promise<void> => {
    const refused = await run(
      async () => {
        await deleteTeam(team.id);
      },
      t`${name} couldn't be deleted. Try again.`
    );
    if (refused !== undefined) {
      throw new Error(refused);
    }
  };
  return (
    <>
      <Item
        actions={
          <>
            <Button
              aria-label={t`Members of ${name}`}
              onClick={() => {
                setOpen("members");
              }}
              size="sm"
            >
              {t`Members`}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                icon={More}
                label={t`Actions for ${name}`}
                size="sm"
                variant="ghost"
              />
              <DropdownMenuPanel align="end">
                <DropdownMenuItem
                  disabled={busy}
                  icon={Edit}
                  onSelect={() => {
                    setOpen("rename");
                  }}
                >
                  {t`Rename`}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  danger
                  disabled={busy}
                  icon={Trash}
                  onSelect={() => {
                    setOpen("delete");
                  }}
                >
                  {t`Delete`}
                </DropdownMenuItem>
              </DropdownMenuPanel>
            </DropdownMenu>
          </>
        }
        size="sm"
        title={
          <TitleLine
            detail={
              <RowNote failure={open === "delete" ? undefined : failure}>
                {t`${plural(count, { one: "# member", other: "# members" })}`}
              </RowNote>
            }
          >
            {name}
          </TitleLine>
        }
      />
      <TeamNameDialog
        except={team.id}
        initial={name}
        onOpenChange={close}
        onSave={async (renamed) =>
          await run(
            async () => {
              await renameTeam(team.id, renamed);
            },
            t`${name} couldn't be renamed. Try again.`
          )
        }
        open={open === "rename"}
        submit={t`Rename`}
        teams={teams}
        title={t`Rename ${name}`}
      />
      <AlertDialog onOpenChange={close} open={open === "delete"}>
        <AlertDialogPanel>
          <AlertDialogTitle>{t`Delete ${name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`What is shared with this team stops being shared with its members through it, and the workflows it owns no longer have a team. Its members stay in the organization.`}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
            <AlertDialogAction
              action={remove}
              failedLabel={t`Could not delete`}
              variant="danger"
              workingLabel={t`Deleting`}
            >
              {t`Delete`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogPanel>
      </AlertDialog>
      <TeamMembersDialog
        members={members}
        onChanged={onChanged}
        onOpenChange={close}
        open={open === "members"}
        team={team}
      />
    </>
  );
};

/** The organization's teams, once read. */
const TeamsList = ({
  data,
  onChanged,
}: {
  data: TeamsData;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { teams, members } = data;
  return (
    <SectionCard
      actions={<NewTeamButton onChanged={onChanged} teams={teams} />}
      description={t`Share Apps, Knowledge and workflows with a whole team at once.`}
      flush={teams.length > 0}
      title={t`Teams`}
    >
      {teams.length === 0 ? (
        <Text tone="muted">{t`No teams yet.`}</Text>
      ) : (
        <ItemGroup aria-label={t`Teams`} separated>
          {teams.map((team) => (
            <TeamRow
              key={team.id}
              members={members}
              onChanged={onChanged}
              team={team}
              teams={teams}
            />
          ))}
        </ItemGroup>
      )}
    </SectionCard>
  );
};

/** The Teams tab: read when it is first opened, and again after each change. */
export const TeamsPanel = () => {
  const { t } = useLingui();
  const core = useCore();
  const [loaded, setLoaded] = useState<Loaded<TeamsData>>();
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const first = await readTeams(core, left.signal);
      if (!left.signal.aborted) {
        setLoaded(first);
      }
    };
    void read();
    return () => {
      left.abort();
    };
  }, [core]);
  const reload = async (): Promise<void> => {
    setLoaded(await readTeams(core));
  };
  if (loaded === undefined) {
    return (
      <SectionCard title={t`Teams`}>
        <LoadingLines lines={3} />
      </SectionCard>
    );
  }
  return loaded.state === "ready" ? (
    <TeamsList data={loaded.data} onChanged={reload} />
  ) : (
    <SectionCard title={t`Teams`}>
      <SectionNotLoaded
        onRetry={() => {
          void reload();
        }}
        page={loaded}
      />
    </SectionCard>
  );
};
