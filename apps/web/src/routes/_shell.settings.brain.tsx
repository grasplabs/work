import type { Team, TeamGroup } from "@grasp-os/shared/brain";
import { Button } from "@grasp-os/ui/components/button";
import { FieldGroup } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, PlusIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import {
  FactRow,
  Failure,
  SettingRow,
  SettingsError,
  SettingsGroup,
  SettingsPending,
  SettingsStack,
} from "../settings/section.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Settings › Brain: the company's groups of teams, the brain's regions
// (core's brain-team-groups.ts). The prototype keeps its groups as data
// and has no page for them; this one is in its settings' language: a
// card with the groups, each named in a field, and every team beside the
// group it is in. Grasp arranges new teams into groups by itself; here an
// admin renames a group or moves a team, and core keeps the set whole,
// with the set before it. For admins; core refuses anyone else.

/** A group as the admin is shaping it. */
type Draft = Omit<TeamGroup, "confirmed">;

/** No group, in a team's choice of group. */
const none = "";

/** A new group's id: a short random one, as a group id may be. */
const newGroupId = (): string => `group-${crypto.randomUUID().slice(0, 8)}`;

/** `groups` with `teamId` moved into `groupId`, or out of every group for {@link none}. */
const moved = (
  groups: readonly Draft[],
  teamId: string,
  groupId: string
): Draft[] =>
  groups.map((group) => {
    const without = group.teamIds.filter((id) => id !== teamId);
    return {
      ...group,
      teamIds: group.id === groupId ? [...without, teamId] : without,
    };
  });

const styles = stylex.create({
  // The group's choice at a select's own width, on the rows' edge.
  choice: { width: "12rem", maxWidth: "100%" },
  add: { paddingBlock: space[2], paddingInline: space.tableCellInline },
  foot: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space[3],
    width: "100%",
  },
});

/** One team, and the group it is in, to choose another. */
const TeamRow = ({
  team,
  groups,
  disabled,
  onMove,
}: {
  team: Team;
  groups: readonly Draft[];
  disabled: boolean;
  onMove: (groupId: string) => void;
}) => {
  const { t } = useLingui();
  const { name } = team;
  const inGroup =
    groups.find(({ teamIds }) => teamIds.includes(team.id))?.id ?? none;
  const items = [
    ...groups.map(({ id, name: group }) => ({ value: id, label: group })),
    { value: none, label: t`No group` },
  ];
  return (
    <FactRow label={name}>
      <div {...stylex.props(styles.choice)}>
        <Select
          disabled={disabled}
          items={items}
          onValueChange={(value) => {
            if (typeof value === "string") {
              onMove(value);
            }
          }}
          value={inGroup}
        >
          <SelectTrigger aria-label={t`Group of ${name}`} size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </FactRow>
  );
};

/** The groups, named, and the teams in them, to save as a whole. */
const TeamGroups = ({
  teams,
  held,
}: {
  teams: readonly Team[];
  held: readonly TeamGroup[];
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [groups, setGroups] = useState<Draft[]>(() =>
    held.map(({ id, name, teamIds }) => ({ id, name, teamIds }))
  );
  const unnamed = groups.some(({ name }) => name.trim() === "");
  const save = (): void => {
    void (async () => {
      // A group with no team in it is left out: a group holds teams.
      const kept = groups
        .filter(({ teamIds }) => teamIds.length > 0)
        .map((group) => ({ ...group, name: group.name.trim() }));
      const saved = await run(
        async (session) => await session.brain.saveTeamGroups(kept)
      );
      if (saved !== undefined) {
        await router.invalidate();
      }
    })();
  };
  if (teams.length === 0) {
    return (
      <SettingsGroup flush={false} title={t`Groups of teams`}>
        <Text color="muted" size="sm">
          {t`The brain has no teams to group yet.`}
        </Text>
      </SettingsGroup>
    );
  }
  return (
    <SettingsStack>
      <SettingsGroup
        description={t`The brain's regions: your teams, grouped the way your company is. Grasp groups new teams by itself; rename a group or move a team here.`}
        title={t`Groups of teams`}
      >
        <FieldGroup>
          {groups.map((group, at) => {
            const number = at + 1;
            return (
              <SettingRow key={group.id} label={t`Group ${number}`}>
                <Input
                  aria-label={t`Group name`}
                  maxLength={80}
                  onValueChange={(value) => {
                    setGroups(
                      groups.map((each) =>
                        each.id === group.id ? { ...each, name: value } : each
                      )
                    );
                  }}
                  readOnly={busy}
                  size="sm"
                  value={group.name}
                />
              </SettingRow>
            );
          })}
        </FieldGroup>
        <div {...stylex.props(styles.add)}>
          <Button
            disabled={busy}
            onClick={() => {
              setGroups([
                ...groups,
                { id: newGroupId(), name: t`New group`, teamIds: [] },
              ]);
            }}
            size="sm"
            variant="ghost"
          >
            <Icon icon={PlusIcon} />
            {t`Add a group`}
          </Button>
        </div>
      </SettingsGroup>
      <SettingsGroup
        footer={
          <div {...stylex.props(styles.foot)}>
            <Failure>{failure}</Failure>
            <Button disabled={busy || unnamed} onClick={save} size="sm">
              {t`Save groups`}
            </Button>
          </div>
        }
        title={t`Teams`}
      >
        <FieldGroup>
          {teams.map((team) => (
            <TeamRow
              disabled={busy}
              groups={groups}
              key={team.id}
              onMove={(groupId) => {
                setGroups(moved(groups, team.id, groupId));
              }}
              team={team}
            />
          ))}
        </FieldGroup>
      </SettingsGroup>
    </SettingsStack>
  );
};

const BrainSettings = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  if (page.state !== "ready") {
    return (
      <SettingsGroup flush={false} title={t`Groups of teams`}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsGroup>
    );
  }
  const { teams, teamGroups } = page.data;
  return (
    <TeamGroups
      held={teamGroups}
      // Read again after a save: the groups as core kept them, any change
      // not saved set aside.
      key={teamGroups
        .map(({ id, name, teamIds }) => [id, name, teamIds.join(",")].join(":"))
        .join("|")}
      teams={teams}
    />
  );
};

export const Route = createFileRoute("/_shell/settings/brain")({
  pendingComponent: () => <SettingsPending groups={[2, 4]} />,
  errorComponent: SettingsError,
  component: BrainSettings,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => {
      const { teams, teamGroups } = await session.brain.read();
      return { teams, teamGroups };
    }),
});
