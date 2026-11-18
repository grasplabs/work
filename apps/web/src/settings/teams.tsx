import type { Member, OrganizationTeam } from "@grasp-os/shared/members";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { formatList } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogContent,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";
import { AvatarGroup } from "../grasp/avatar/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogFooter,
  DialogContent,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import { Field, FieldError, FieldLabel } from "../grasp/field/index.ts";
import { focus } from "../grasp/focus/focus.ts";
import { Form } from "../grasp/form/index.ts";
import { Edit, More, Plus, Trash } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemDescription,
  ItemTitle,
  ItemActions,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { LoadingLines, RowNote, SectionNotLoaded } from "./section.tsx";
import { createTeam, deleteTeam } from "./team-changes.ts";
import { isTaken, TeamDialog } from "./team-members-dialog.tsx";
import { useTeamChange } from "./use-team-change.ts";

// Teams, for admins (GRA-1296): the organization's teams, each with how
// many are in it; making one, renaming it, deleting it, and who is in it.
// Everything that is shared with a team ("Chosen teams") picks from these.
// They aren't the onboarding's roster teams, which are a list of their
// own. Better Auth checks the role on every
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
    borderRadius: grasp.cornerMark,
    textDecorationLine: { default: "none", ":hover": "underline" },
    textUnderlineOffset: "0.2em",
  },
  ends: { display: "flex", alignItems: "center", gap: grasp.space3 },
});

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
      <DialogContent closeLabel={t`Close`}>
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
        icon={Plus}
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
        // Quiet: Invite is the page's one main action.
        variant="quiet"
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
            {...stylex.props(styles.open, focus.ring)}
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
            <AvatarGroup
              aria-label={t`People in ${name}`}
              people={people}
              words={{
                more: (count) => `+${String(count)}`,
                name: (shown, rest) => {
                  const listed = formatList(shown);
                  return rest === 0
                    ? listed
                    : t`${listed} and ${plural(rest, { one: "# other", other: "# others" })}`;
                },
              }}
            />
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t`Actions for ${name}`}
              disabled={busy}
              icon={More}
              size="xs"
              variant="ghost"
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem icon={Edit} onSelect={onOpen}>
                {t`Rename`}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                icon={Trash}
                onSelect={() => {
                  setDeleting(true);
                }}
                variant="danger"
              >
                {t`Delete`}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
        <AlertDialog onOpenChange={setDeleting} open={deleting}>
          <AlertDialogContent>
            <AlertDialogTitle>{t`Delete ${name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`What is shared with this team stops being shared with its members through it, and the workflows it owns no longer have a team. Its members stay in the organization.`}
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
              <AlertDialogAction
                action={remove}
                failedLabel={t`Not deleted`}
                variant="danger"
                workingLabel={t`Deleting`}
              >
                {t`Delete`}
              </AlertDialogAction>
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
    <SectionCard
      actions={<NewTeamButton onChanged={onChanged} teams={teams} />}
      density="compact"
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
              onOpen={() => {
                setOpened(team.id);
              }}
              team={team}
            />
          ))}
        </ItemGroup>
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
