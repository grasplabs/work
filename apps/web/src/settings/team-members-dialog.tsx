import type { Member, OrganizationTeam } from "@grasp-os/shared/members";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";

import { Alert } from "../grasp/alert/index.ts";
import { Avatar, AvatarFallback } from "../grasp/avatar/index.ts";
import { Checkbox } from "../grasp/checkbox/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { Field, FieldError, FieldLabel } from "../grasp/field/index.ts";
import { Search } from "../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { ScrollArea } from "../grasp/scroll-area/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { addTeamMember, removeTeamMember, renameTeam } from "./team-changes.ts";
import { useTeamChange } from "./use-team-change.ts";

// A team's own dialog, as the library's Members pattern has it: its name,
// renamed in a field, and one field to find the organization's members and
// tick them; ticked means in the team. Who is in it stands first, ticked,
// in the order set as the dialog opens, so ticking never moves a row. Save
// changes renames it and puts on and takes off whoever changed, through
// Better Auth's organization routes (team-changes.ts), then reads the
// teams again; a refused change keeps the dialog open with what was asked.

const styles = stylex.create({
  fields: { display: "grid", gap: grasp.space4 },
  people: { display: "grid", gap: grasp.space2 },
  // The list scrolls inside the field, so the dialog keeps its size with
  // forty people. Its rows step out by Item's own inline room, so each
  // checkbox stands on the fields' start edge.
  list: {
    height: "16rem",
    marginInline: `calc(-1 * ${grasp.tableCellInline})`,
  },
  label: {
    margin: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  rows: { display: "grid", margin: 0, padding: 0, listStyle: "none" },
  // A hairline between rows, as the people's list has, the fields' width:
  // the rows step out by Item's inline room, the line steps back in.
  row: { position: "relative" },
  line: {
    "::before": {
      content: "''",
      position: "absolute",
      top: 0,
      insetInline: grasp.tableCellInline,
      height: grasp.hairline,
      backgroundColor: grasp.line,
    },
  },
  press: { display: "block", cursor: "pointer" },
  who: { display: "inline-flex", alignItems: "center", gap: grasp.space2 },
  count: {
    margin: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
});

/** One of the organization's members, to tick into the team: the whole row is the checkbox's label. */
const PersonRow = ({
  member,
  chosen,
  first,
  onTick,
}: {
  member: Member;
  chosen: boolean;
  first: boolean;
  onTick: (on: boolean) => void;
}) => {
  const id = useId();
  return (
    <li {...stylex.props(styles.row, !first && styles.line)}>
      <label htmlFor={id} {...stylex.props(styles.press)}>
        <Item size="xs">
          <ItemMedia>
            <span {...stylex.props(styles.who)}>
              <Checkbox
                checked={chosen}
                id={id}
                onCheckedChange={(on) => {
                  onTick(on === true);
                }}
              />
              <Avatar decorative name={member.name} size="xs">
                <AvatarFallback />
              </Avatar>
            </span>
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{member.name}</ItemTitle>
            <ItemDescription>{member.email}</ItemDescription>
          </ItemContent>
        </Item>
      </label>
    </li>
  );
};

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
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{team?.name ?? ""}</DialogTitle>
        <DialogBody>
          <div {...stylex.props(styles.fields)}>
            <Field invalid={problem !== undefined} name="team-name">
              <FieldLabel>{t`Name`}</FieldLabel>
              <Input
                onValueChange={(value) => {
                  setName(value);
                  setProblem(undefined);
                }}
                value={name}
              />
              {problem === undefined ? null : (
                <FieldError match>{problem}</FieldError>
              )}
            </Field>
            <section aria-label={t`People`} {...stylex.props(styles.people)}>
              <p {...stylex.props(styles.label)}>{t`People`}</p>
              <InputGroup>
                <InputGroupText icon={Search} />
                <InputGroupInput
                  aria-label={t`Find people`}
                  onValueChange={setQuery}
                  placeholder={t`Find people`}
                  type="search"
                  value={query}
                />
              </InputGroup>
              {/* The list scrolls inside the field, so the dialog keeps its size with forty people. */}
              <ScrollArea aria-label={t`People to tick`} layout={styles.list}>
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
                    {found.map((member, index) => (
                      <PersonRow
                        chosen={chosen.includes(member.userId)}
                        first={index === 0}
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
              <p role="status" {...stylex.props(styles.count)}>
                {t`${plural(count, { one: "# person in the team", other: "# people in the team" })}`}
              </p>
            </section>
            {failure === undefined ? null : (
              <Alert tone="danger">{failure}</Alert>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogAction>{t`Cancel`}</DialogAction>
          <DialogAction
            action={save}
            failedLabel={t`Not saved`}
            variant="ink"
            workingLabel={t`Saving`}
          >
            {t`Save changes`}
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
