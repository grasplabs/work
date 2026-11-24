import type {
  DirectoryPlacement,
  Member,
  OrganizationTeam,
} from "@grasp-os/shared/members";
import { Alert } from "@grasp-os/ui/components/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { AvatarGroup } from "@grasp-os/ui/components/avatar";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
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
import { Form } from "@grasp-os/ui/components/form";
import { Input } from "@grasp-os/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Text } from "@grasp-os/ui/components/text";
import {
  EllipsisIcon,
  Icon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "@grasp-os/ui/lib/icons";
import { focusRingText } from "@grasp-os/ui/lib/styles";
import { radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { SeparatedItems } from "../workflows/separated-items.tsx";
import { DirectoryPlacementSections } from "./directory-placement.tsx";
import { LoadingLines, RowNote, SettingsGroup } from "./section.tsx";
import { createTeam, deleteTeam } from "./team-changes.ts";
import { isTaken, TeamDialog } from "./team-members-dialog.tsx";
import { useTeamChange } from "./use-team-change.ts";

// Teams, for admins (GRA-1296): the organization's teams, each with how
// many are in it; making one, renaming it, deleting it, and who is in it.
// Everything that is shared with a team ("Chosen teams") picks from these,
// and so does the onboarding's staff list, which names these same teams
// (GRA-2055). Better Auth checks the role on every
// change and core on every read; only admins see this tab at all.

const styles = stylex.create({
  // The team's name opens it: a button that looks like the row's title.
  open: {
    margin: 0,
    padding: 0,
    appearance: "none",
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "start",
    cursor: "pointer",
    borderRadius: radius.sm,
    textDecorationLine: { default: "none", ":hover": "underline" },
    textUnderlineOffset: "0.2em",
  },
  ends: { display: "flex", alignItems: "center", gap: space["3"] },
});

/** What the tab shows: the teams, and the members to put in them. */
interface TeamsData {
  teams: OrganizationTeam[];
  members: Member[];
  /** Whom the directory leaves for an admin to place (directory-placement.tsx). */
  placement: DirectoryPlacement;
}

const readTeams = async (
  core: Pick<CoreConnection, "withSession">,
  left?: AbortSignal
): Promise<Loaded<TeamsData>> =>
  await loadFromCore(
    core,
    async (session) => {
      const [teams, members, placement] = await Promise.all([
        session.members.teams(),
        session.members.list(),
        session.members.directoryPlacement(),
      ]);
      return { teams, members, placement };
    },
    left
  );

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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Form
            aria-label={title}
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Field data-invalid={problem !== undefined}>
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
          <DialogClose>{t`Cancel`}</DialogClose>
          <Button disabled={busy} form={formId} type="submit">
            {submit}
          </Button>
        </DialogFooter>
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
        // Quiet and at the fields' height, as Invite beside the people.
        variant="outline"
      >
        <Icon icon={PlusIcon} />
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

/** How many are in a team, said under its name. */
const useCounted = (count: number): string => {
  const { t } = useLingui();
  return count === 0
    ? t`No one yet: open it to add people`
    : t`${plural(count, { one: "# person", other: "# people" })}`;
};

/**
 * One team: its name, which opens its dialog; how many are in it; its
 * people as a stack of faces; and a menu to rename it (in its dialog) or
 * delete it, which asks first.
 */
const TeamRow = ({
  team,
  members,
  onOpen,
  onChanged,
}: {
  team: OrganizationTeam;
  members: readonly Member[];
  onOpen: () => void;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const [deleting, setDeleting] = useState(false);
  const { busy, failure, run } = useTeamChange(onChanged);
  const { name } = team;
  // Only the organization's members count: someone removed is no longer in it.
  const byId = new Map(members.map((member) => [member.userId, member]));
  const people = team.memberIds.flatMap((userId) => {
    const member = byId.get(userId);
    return member === undefined ? [] : [{ name: member.name }];
  });
  const counted = useCounted(people.length);
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
    <Item size="xs">
      <ItemContent>
        <ItemTitle>
          {/* The name opens the team: the row holds a menu, so it can't be one link. */}
          <button
            onClick={onOpen}
            type="button"
            {...stylex.props(styles.open, focusRingText)}
          >
            {name}
          </button>
        </ItemTitle>
        <ItemDescription>
          <RowNote failure={deleting ? undefined : failure}>{counted}</RowNote>
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <span {...stylex.props(styles.ends)}>
          {people.length > 0 ? (
            <AvatarGroup aria-label={t`People in ${name}`} items={people} />
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={t`Actions for ${name}`}
                disabled={busy}
                size="icon-sm"
                variant="ghost"
              >
                <Icon icon={EllipsisIcon} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem icon={PencilIcon} onSelect={onOpen}>
                {t`Rename`}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                icon={TrashIcon}
                onSelect={() => {
                  setDeleting(true);
                }}
                variant="destructive"
              >
                {t`Delete`}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
        <AlertDialog onOpenChange={setDeleting} open={deleting}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t`Delete ${name}?`}</AlertDialogTitle>
              <AlertDialogDescription>
                {t`What is shared with this team stops being shared with its members through it, and the workflows it owns no longer have a team. Its members stay in the organization.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {/* Why core refused it, where the person is: the staff list's, or that only admins change teams. */}
            {failure === undefined ? null : (
              <Alert variant="destructive">{failure}</Alert>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel />
              <Button
                errorText={t`Not deleted`}
                loadingText={t`Deleting`}
                onClick={async () => {
                  await remove();
                  setDeleting(false);
                }}
                variant="destructive"
              >
                {t`Delete`}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ItemActions>
    </Item>
  );
};

/** The organization's teams, once read: a second card under the people. */
const TeamsList = ({
  data,
  onChanged,
}: {
  data: TeamsData;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { teams, members } = data;
  const [opened, setOpened] = useState<string>();
  const open = teams.find(({ id }) => id === opened);
  return (
    <>
      <SettingsGroup
        actions={<NewTeamButton onChanged={onChanged} teams={teams} />}
        flush={teams.length > 0}
        title={t`Teams`}
      >
        {teams.length === 0 ? (
          <Text color="muted">{t`No teams yet.`}</Text>
        ) : (
          <SeparatedItems
            aria-label={t`Teams`}
            rows={teams.map((team) => ({
              key: team.id,
              row: (
                <TeamRow
                  members={members}
                  onChanged={onChanged}
                  onOpen={() => {
                    setOpened(team.id);
                  }}
                  team={team}
                />
              ),
            }))}
          />
        )}
        {/* A new dialog for each team opened, so it starts from that team's name and people. */}
        <TeamDialog
          key={open?.id ?? "closed"}
          members={members}
          onChanged={onChanged}
          onClose={() => {
            setOpened(undefined);
          }}
          team={open}
          teams={teams}
        />
      </SettingsGroup>
      {/* Whom the directory leaves to place, and the hand pins: each only while it lists someone. */}
      <DirectoryPlacementSections
        onChanged={onChanged}
        placement={data.placement}
        teams={teams}
      />
    </>
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
      <SettingsGroup title={t`Teams`}>
        <LoadingLines lines={3} />
      </SettingsGroup>
    );
  }
  return loaded.state === "ready" ? (
    <TeamsList data={loaded.data} onChanged={reload} />
  ) : (
    <SettingsGroup title={t`Teams`}>
      <NotLoadedState
        again={() => {
          void reload();
        }}
        heading="h3"
        page={loaded}
      />
    </SettingsGroup>
  );
};
