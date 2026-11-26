import type { Team, TeamGroup } from "@grasp-os/shared/brain";
import { isAdmin } from "@grasp-os/shared/roles";
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
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { NotLoadedState } from "../frame/page-states.tsx";
import { PageSkeletonSettings } from "../frame/skeletons/settings.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import {
  SettingRow,
  SettingsError,
  SettingsGroup,
} from "../settings/section.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Settings → Brain: the company's groups of teams, the brain's regions
// (core's brain-team-groups.ts). The reference has no page for them; this
// one is in its settings' language: a card of the groups, each named in a
// field, then a card of every team beside the group it is in. Grasp arranges new teams into groups by itself; here an
// admin renames a group or moves a team, and core keeps the set whole,
// with the set before it. For admins: anyone else is sent to Profile, and
// core refuses them.

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
  // Every control fills the rows' shared control column.
  control: { width: "100%" },
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
    <SettingRow label={name}>
      <Select
        disabled={disabled}
        items={items}
        onValueChange={(value: unknown) => {
          if (typeof value === "string") {
            onMove(value);
          }
        }}
        value={inGroup}
      >
        <SelectTrigger size="sm" style={styles.control}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} label={item.label} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
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
  const description = t`The brain's regions: your teams, grouped the way your company is. Grasp groups new teams by itself; rename a group or move a team here.`;
  if (teams.length === 0) {
    return (
      <SettingsGroup description={description} title={t`Groups of teams`}>
        <Text color="muted" size="sm">
          {t`The brain has no teams to group yet.`}
        </Text>
      </SettingsGroup>
    );
  }
  return (
    <>
      <SettingsGroup
        actions={
          <Button
            disabled={busy}
            onClick={() => {
              setGroups([
                ...groups,
                { id: newGroupId(), name: t`New group`, teamIds: [] },
              ]);
            }}
            size="xs"
            variant="outline"
          >
            <Icon icon={PlusIcon} />
            {t`Add a group`}
          </Button>
        }
        description={description}
        flush
        title={t`Groups of teams`}
      >
        <FieldGroup>
          {groups.map((group, index) => {
            const number = index + 1;
            return (
              <SettingRow key={group.id} label={t`Group ${number}`}>
                <Input
                  disabled={busy}
                  maxLength={80}
                  onValueChange={(value) => {
                    setGroups(
                      groups.map((each) =>
                        each.id === group.id ? { ...each, name: value } : each
                      )
                    );
                  }}
                  size="sm"
                  style={styles.control}
                  value={group.name}
                />
              </SettingRow>
            );
          })}
        </FieldGroup>
      </SettingsGroup>
      <SettingsGroup
        flush
        footer={
          <>
            <ErrorText>{failure}</ErrorText>
            <Button disabled={busy || unnamed} onClick={save} size="sm">
              {t`Save groups`}
            </Button>
          </>
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
    </>
  );
};

const BrainSettings = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  if (page.state !== "ready") {
    return (
      <SettingsGroup title={t`Groups of teams`}>
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

/** The groups' card and the teams' while they are read. */
const BrainPending = () => <PageSkeletonSettings sections={[2, 3]} />;

export const Route = createFileRoute("/_shell/settings/brain")({
  // Only admins shape the groups: anyone else who follows a link here goes
  // to their own settings, as Teams and Incoming events send them. Core
  // refuses them all the same; this only spares them a page they can't use.
  beforeLoad: ({ context: { identity } }) => {
    if (!isAdmin(identity.role)) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/settings/profile", replace: true });
    }
  },
  pendingComponent: BrainPending,
  errorComponent: SettingsError,
  component: BrainSettings,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => {
      const { teams, teamGroups } = await session.brain.read();
      return { teams, teamGroups };
    }),
});
