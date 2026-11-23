import type { Member, OrganizationTeam } from "@grasp-os/shared/members";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Field,
  FieldContent,
  FieldError,
  FieldLabel,
  FieldTitle,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { ScrollArea } from "@grasp-os/ui/components/scroll-area";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, SearchIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { Failure } from "./section.tsx";
import { addTeamMember, removeTeamMember, renameTeam } from "./team-changes.ts";
import { useTeamChange } from "./use-team-change.ts";

// A team's own dialog: its name, renamed in a field, and one field to find
// the organization's members and tick them; ticked means in the team. Who
// is in it stands first, ticked, in the order set as the dialog opens, so
// ticking never moves a row. Save changes renames it and puts on and takes
// off whoever changed, through Better Auth's organization routes
// (team-changes.ts), then reads the teams again; a refused change keeps
// the dialog open with what was asked.

const styles = stylex.create({
  fields: { display: "grid", gap: space[4] },
  people: { display: "grid", gap: space[2] },
  // The list scrolls inside the field, so the dialog keeps its size with
  // forty people.
  list: { height: "16rem" },
  rows: { display: "grid", margin: 0, padding: 0, listStyle: "none" },
  // A person's face, name and email, as the checkbox's label.
  who: {
    display: "inline-flex",
    alignItems: "center",
    gap: space[2],
    minWidth: 0,
  },
});

/** One of the organization's members, to tick into the team: their face, name and email name the box. */
const PersonRow = ({
  member,
  chosen,
  onTick,
}: {
  member: Member;
  chosen: boolean;
  onTick: (on: boolean) => void;
}) => (
  <li>
    <Field orientation="horizontal">
      <Checkbox
        checked={chosen}
        onCheckedChange={(on) => {
          onTick(on === true);
        }}
      />
      <FieldContent>
        <FieldLabel>
          <span {...stylex.props(styles.who)}>
            <Avatar decorative name={member.name} size="xs">
              <AvatarFallback />
            </Avatar>
            {member.name}{" "}
            <Text as="span" color="muted" size="sm" wrap="anywhere">
              {member.email}
            </Text>
          </span>
        </FieldLabel>
      </FieldContent>
    </Field>
  </li>
);

/** Whether `name` is another team's already, whatever its case. */
export const isTaken = (
  name: string,
  teams: readonly OrganizationTeam[],
  except?: string
): boolean => {
  const wanted = name.trim().toLocaleLowerCase();
  return teams.some(
    (team) => team.id !== except && team.name.toLocaleLowerCase() === wanted
  );
};

/** Whether `member` is who `query` names, by name or email. */
const matches = (member: Member, query: string): boolean => {
  const words = query.trim().toLocaleLowerCase();
  return (
    words === "" ||
    `${member.name} ${member.email}`.toLocaleLowerCase().includes(words)
  );
};

/** The members, the team's own first, each part by name. */
const teamFirst = (
  members: readonly Member[],
  inTeam: readonly string[]
): Member[] => {
  const ours = new Set(inTeam);
  const rank = (member: Member): number => (ours.has(member.userId) ? 0 : 1);
  return members.toSorted(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)
  );
};

/** Renames `team` to `name` if it changed, and puts on and takes off whoever changed. */
const saveTeam = async (
  team: OrganizationTeam,
  name: string,
  chosen: readonly string[]
): Promise<void> => {
  if (name !== team.name) {
    await renameTeam(team.id, name);
  }
  const before = new Set(team.memberIds);
  const after = new Set(chosen);
  for (const userId of chosen) {
    if (!before.has(userId)) {
      // oxlint-disable-next-line no-await-in-loop -- one change at a time, so a refusal says where it stopped
      await addTeamMember(team.id, userId);
    }
  }
  for (const userId of team.memberIds) {
    if (!after.has(userId)) {
      // oxlint-disable-next-line no-await-in-loop -- one change at a time, as above
      await removeTeamMember(team.id, userId);
    }
  }
};

/** The team's dialog: open while `team` is given. */
export const TeamDialog = ({
  team,
  teams,
  members,
  onClose,
  onChanged,
}: {
  team: OrganizationTeam | undefined;
  teams: readonly OrganizationTeam[];
  members: readonly Member[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const [name, setName] = useState(team?.name ?? "");
  const [chosen, setChosen] = useState<string[]>(team?.memberIds ?? []);
  const [query, setQuery] = useState("");
  const [problem, setProblem] = useState<string>();
  const { failure, run } = useTeamChange(onChanged);
  // The order is set as the dialog opens: the team's people first.
  // oxlint-disable-next-line react/hook-use-state -- fixed as the dialog opens, never set
  const [order] = useState(() => teamFirst(members, team?.memberIds ?? []));
  const found = order.filter((member) => matches(member, query));
  const count = chosen.length;
  const tick = (userId: string, on: boolean): void => {
    setChosen((all) =>
      on ? [...all, userId] : all.filter((each) => each !== userId)
    );
  };
  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (team === undefined) {
      return;
    }
    if (trimmed === "") {
      setProblem(t`Give the team a name.`);
      throw new Error("The team needs a name.");
    }
    if (isTaken(trimmed, teams, team.id)) {
      setProblem(t`There is a team with this name already.`);
      throw new Error("The name is taken.");
    }
    const current = team.name;
    // Core's refusal, in words: the staff list's, or that only admins change teams.
    const refused = await run(
      async () => {
        await saveTeam(team, trimmed, chosen);
      },
      t`${current} couldn't be saved. Try again.`
    );
    if (refused !== undefined) {
      throw new Error(refused);
    }
    onClose();
  };
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={team !== undefined}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{team?.name ?? ""}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div {...stylex.props(styles.fields)}>
            <Field data-invalid={problem !== undefined} name="team-name">
              <FieldLabel>{t`Name`}</FieldLabel>
              <Input
                onValueChange={(value) => {
                  setName(value);
                  setProblem(undefined);
                }}
                value={name}
              />
              <FieldError match>{problem}</FieldError>
            </Field>
            <section aria-label={t`People`} {...stylex.props(styles.people)}>
              <FieldTitle>{t`People`}</FieldTitle>
              <InputGroup>
                <InputGroupAddon>
                  <Icon icon={SearchIcon} />
                </InputGroupAddon>
                <InputGroupInput
                  aria-label={t`Find people`}
                  onValueChange={setQuery}
                  placeholder={t`Find people`}
                  type="search"
                  value={query}
                />
              </InputGroup>
              {/* The list scrolls inside the field, so the dialog keeps its size with forty people. */}
              <ScrollArea aria-label={t`People to tick`} style={styles.list}>
                {found.length === 0 ? (
                  <Empty size="sm">
                    <EmptyHeader>
                      <EmptyTitle>{t`No one by that name`}</EmptyTitle>
                      <EmptyDescription>
                        {t`Invite them from the people list first.`}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <ul {...stylex.props(styles.rows)}>
                    {found.map((member) => (
                      <PersonRow
                        chosen={chosen.includes(member.userId)}
                        key={member.userId}
                        member={member}
                        onTick={(on) => {
                          tick(member.userId, on);
                        }}
                      />
                    ))}
                  </ul>
                )}
              </ScrollArea>
              {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not every screen reader treats <output> as a live region */}
              <p role="status">
                <Text as="span" color="muted" size="xs">
                  {t`${plural(count, { one: "# person in the team", other: "# people in the team" })}`}
                </Text>
              </p>
            </section>
            <Failure>{failure}</Failure>
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose>{t`Cancel`}</DialogClose>
          <Button
            errorText={t`Not saved`}
            loadingText={t`Saving`}
            onClick={save}
            size="sm"
          >
            {t`Save changes`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
