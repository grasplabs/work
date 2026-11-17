import type { Member, OrganizationTeam } from "@grasp-os/shared/members";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Combobox } from "../grasp/combobox/index.ts";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogContent,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import { Field, FieldError, FieldLabel } from "../grasp/field/index.ts";
import { Form, FormActions } from "../grasp/form/index.ts";
import { Minus } from "../grasp/icons/index.ts";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "../grasp/item/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { addTeamMember, removeTeamMember } from "./team-changes.ts";
import { useTeamChange } from "./use-team-change.ts";

// Who is in a team, for admins: each of them, a way to take them off it,
// and a way to put any other member of the organization on it.

/** Someone in the team: a member, or only their ID if they aren't listed. */
interface InTeam {
  userId: string;
  name: string;
  email?: string;
}

/** The team's people by name, as the organization's members name them. */
const peopleIn = (
  team: OrganizationTeam,
  members: readonly Member[]
): InTeam[] => {
  const byId = new Map(members.map((member) => [member.userId, member]));
  return team.memberIds
    .map((userId) => byId.get(userId) ?? { userId, name: userId })
    .toSorted((a, b) => a.name.localeCompare(b.name));
};

/** The organization's members not in the team yet, by name. */
const othersOf = (
  team: OrganizationTeam,
  members: readonly Member[]
): { value: string; label: string }[] => {
  const inTeam = new Set(team.memberIds);
  return members
    .filter((member) => !inTeam.has(member.userId))
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((member) => ({
      value: member.userId,
      label: `${member.name} (${member.email})`,
    }));
};

const styles = stylex.create({
  body: { display: "flex", flexDirection: "column", gap: grasp.space5 },
});

export const TeamMembersDialog = ({
  team,
  members,
  open,
  onOpenChange,
  onChanged,
}: {
  team: OrganizationTeam;
  members: readonly Member[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const [chosen, setChosen] = useState<string | null>(null);
  // Adding and taking off fail apart, each saying so where it was asked.
  const adding = useTeamChange(onChanged);
  const takingOff = useTeamChange(onChanged);
  const busy = adding.busy || takingOff.busy;
  const { name } = team;
  const people = peopleIn(team, members);
  const others = othersOf(team, members);
  // One that was added since, or left the organization, is no longer offered.
  const picked = others.some((other) => other.value === chosen) ? chosen : null;
  const add = async (userId: string): Promise<void> => {
    const refused = await adding.run(
      async () => {
        await addTeamMember(team.id, userId);
      },
      t`They couldn't be added to ${name}. Try again.`
    );
    if (refused === undefined) {
      setChosen(null);
    }
  };
  const remove = async (person: InTeam): Promise<void> => {
    const who = person.name;
    await takingOff.run(
      async () => {
        await removeTeamMember(team.id, person.userId);
      },
      t`${who} couldn't be taken off ${name}. Try again.`
    );
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Members of ${name}`}</DialogTitle>
        <DialogDescription>
          {t`What is shared with ${name} is shared with each of them.`}
        </DialogDescription>
        <DialogBody>
          <div {...stylex.props(styles.body)}>
            {others.length === 0 ? (
              <Text tone="muted">
                {t`Everyone in the organization is in this team.`}
              </Text>
            ) : (
              <Form
                aria-label={t`Add a member`}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (picked !== null) {
                    void add(picked);
                  }
                }}
              >
                <Field invalid={adding.failure !== undefined}>
                  <FieldLabel>{t`Add a member`}</FieldLabel>
                  <Combobox
                    empty={t`Nobody by that name`}
                    items={others}
                    onValueChange={setChosen}
                    placeholder={t`Choose someone`}
                    triggerLabel={t`Show the members`}
                    value={picked}
                  />
                  {adding.failure === undefined ? null : (
                    <FieldError match>{adding.failure}</FieldError>
                  )}
                </Field>
                <FormActions align="start">
                  <Button disabled={busy || picked === null} type="submit">
                    {t`Add`}
                  </Button>
                </FormActions>
              </Form>
            )}
            {takingOff.failure === undefined ? null : (
              <Alert tone="danger">{takingOff.failure}</Alert>
            )}
            {people.length === 0 ? (
              <Text tone="muted">{t`Nobody is in this team yet.`}</Text>
            ) : (
              <ItemGroup aria-label={t`Members of ${name}`} separated>
                {people.map((person) => {
                  const who = person.name;
                  return (
                    <Item key={person.userId} size="sm">
                      <ItemContent>
                        <ItemTitle>{person.name}</ItemTitle>
                        <ItemDescription>{person.email}</ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Button
                          disabled={busy}
                          icon={Minus}
                          aria-label={t`Take ${who} off ${name}`}
                          onClick={() => {
                            void remove(person);
                          }}
                          size="sm"
                          variant="ghost"
                        />
                      </ItemActions>
                    </Item>
                  );
                })}
              </ItemGroup>
            )}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
