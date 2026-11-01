import type { Member, OrganizationTeam } from "@grasp-os/shared/members";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Field, FieldError, FieldLabel } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  EllipsisIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useId, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { LoadingLines, NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { SettingsBody, SettingsSection } from "./settings-parts.tsx";
import { createTeam, deleteTeam, renameTeam } from "./team-changes.ts";
import { TeamMembersDialog } from "./team-members-dialog.tsx";
import { useTeamChange } from "./use-team-change.ts";

// Teams, for admins (GRA-1296): the organization's teams, each with how
// many are in it; making one, renaming it, deleting it, and who is in it.
// Everything that is shared with a team ("Chosen teams") picks from these.
// They aren't the onboarding's roster teams (onboarding-organization.ts),
// which are a list of their own. Better Auth checks the role on every
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
  const nameId = useId();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const taken = isTaken(name, teams, except);
  const problem = taken ? t`There is a team with this name already.` : failure;
  const save = async (): Promise<void> => {
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
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <Field data-invalid={problem === undefined ? undefined : true}>
            <FieldLabel htmlFor={nameId}>
              <Trans>Name</Trans>
            </FieldLabel>
            <Input
              aria-invalid={problem === undefined ? undefined : true}
              autoComplete="off"
              id={nameId}
              onChange={(event) => {
                setName(event.target.value);
                setFailure(undefined);
              }}
              value={name}
            />
            {problem === undefined ? null : <FieldError>{problem}</FieldError>}
          </Field>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              <Trans>Cancel</Trans>
            </DialogClose>
            <Button
              disabled={busy || taken || name.trim() === ""}
              type="submit"
            >
              {submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
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
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
      >
        <PlusIcon data-icon="inline-start" />
        <Trans>New team</Trans>
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
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showing, setShowing] = useState(false);
  const { busy, failure, run } = useTeamChange(onChanged);
  const { name } = team;
  const count = team.memberIds.length;
  const remove = async (): Promise<void> => {
    const refused = await run(
      async () => {
        await deleteTeam(team.id);
      },
      t`${name} couldn't be deleted. Try again.`
    );
    if (refused === undefined) {
      setDeleting(false);
    }
  };
  return (
    <div className="flex items-center gap-3 border-t px-5 py-3">
      <span
        aria-hidden="true"
        className="bg-muted flex size-8 flex-none items-center justify-center rounded-full"
      >
        <UsersIcon className="text-muted-foreground size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{name}</span>
        <span className="text-muted-foreground">
          <Plural one="# member" other="# members" value={count} />
        </span>
        <ErrorText>{deleting ? undefined : failure}</ErrorText>
      </div>
      <Button
        aria-label={t`Members of ${name}`}
        onClick={() => {
          setShowing(true);
        }}
        size="sm"
        variant="outline"
      >
        <Trans>Members</Trans>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t`Actions for ${name}`}
          disabled={busy}
          render={<Button size="icon-sm" variant="ghost" />}
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem
            onClick={() => {
              setRenaming(true);
            }}
          >
            <PencilIcon />
            <Trans>Rename</Trans>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              setDeleting(true);
            }}
            variant="destructive"
          >
            <Trash2Icon />
            <Trans>Delete</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TeamNameDialog
        except={team.id}
        initial={name}
        onOpenChange={setRenaming}
        onSave={async (renamed) =>
          await run(
            async () => {
              await renameTeam(team.id, renamed);
            },
            t`${name} couldn't be renamed. Try again.`
          )
        }
        open={renaming}
        submit={t`Rename`}
        teams={teams}
        title={t`Rename ${name}`}
      />
      <Dialog onOpenChange={setDeleting} open={deleting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Delete {name}?</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                What is shared with this team stops being shared with its
                members through it, and the workflows it owns no longer have a
                team. Its members stay in the organization.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <ErrorText>{failure}</ErrorText>
          <DialogFooter showCloseButton>
            <Button
              disabled={busy}
              onClick={() => {
                void remove();
              }}
              variant="destructive"
            >
              <Trans>Delete</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <TeamMembersDialog
        members={members}
        onChanged={onChanged}
        onOpenChange={setShowing}
        open={showing}
        team={team}
      />
    </div>
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
    <SettingsSection
      action={<NewTeamButton onChanged={onChanged} teams={teams} />}
      description={
        <Trans>
          Teams group the people who work together, so apps, Knowledge and
          workflows can be shared with a whole team at once.
        </Trans>
      }
      title={t`Teams`}
    >
      {teams.length === 0 ? (
        <p className="text-muted-foreground border-t px-5 py-6 text-center">
          <Trans>No teams yet.</Trans>
        </p>
      ) : null}
      {teams.map((team) => (
        <TeamRow
          key={team.id}
          members={members}
          onChanged={onChanged}
          team={team}
          teams={teams}
        />
      ))}
    </SettingsSection>
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
      <SettingsSection title={t`Teams`}>
        <SettingsBody>
          <LoadingLines lines={3} />
        </SettingsBody>
      </SettingsSection>
    );
  }
  return loaded.state === "ready" ? (
    <TeamsList data={loaded.data} onChanged={reload} />
  ) : (
    <SettingsSection title={t`Teams`}>
      <NotLoadedState heading="h3" page={loaded} />
    </SettingsSection>
  );
};
