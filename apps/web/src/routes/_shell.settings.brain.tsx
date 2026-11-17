import type { Team, TeamGroup } from "@grasp-os/shared/brain";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { Agent, Plus } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import { Item, ItemGroup } from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Select } from "../grasp/select/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore } from "../load-from-core.tsx";
import {
  SectionNotLoaded,
  SettingsError,
  SettingsLoading,
  SettingsStack,
} from "../settings/section.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Settings → Brain: the company's groups of teams, the brain's regions
// (core's brain-team-groups.ts). The prototype keeps its groups as data
// and has no page for them; this one is in its settings' language: a
// card with the groups, each named in a field, and every team beside the
// group it is in. Grasp proposes groups on an admin's ask; nothing counts
// until an admin confirms the set, which core keeps whole, with the set
// before it. For admins; core refuses anyone else.

/** A group as the admin is shaping it: no `confirmed` until it is saved. */
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
  part: { display: "flex", flexDirection: "column", gap: grasp.space2 },
  group: { display: "flex", alignItems: "center", gap: grasp.space2 },
  name: { flexGrow: 1, minWidth: 0 },
  // Narrower on a phone, so a team keeps the room for its name.
  choice: { width: { default: "12rem", [media.belowPhone]: "8.5rem" } },
  foot: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: grasp.space3,
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
  return (
    <Item
      actions={
        <div {...stylex.props(styles.choice)}>
          <Select
            aria-label={t`Group of ${name}`}
            disabled={disabled}
            items={[
              ...groups.map(({ id, name: group }) => ({
                value: id,
                label: group,
              })),
              { value: none, label: t`No group` },
            ]}
            onValueChange={(value) => {
              if (typeof value === "string") {
                onMove(value);
              }
            }}
            size="sm"
            value={inGroup}
          />
        </div>
      }
      size="sm"
      title={name}
    />
  );
};

/** The groups, named, and the teams in them, to confirm as a whole. */
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
  const proposed = held.some((group) => !group.confirmed);
  const unnamed = groups.some(({ name }) => name.trim() === "");
  const propose = (): void => {
    void (async () => {
      const next = await run(
        async (session) => await session.brain.proposeTeamGroups()
      );
      if (next !== undefined) {
        await router.invalidate();
      }
    })();
  };
  const confirm = (): void => {
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
  return (
    <SectionCard
      actions={
        <Button
          disabled={busy || teams.length === 0}
          icon={Agent}
          onClick={propose}
          size="sm"
        >
          {t`Propose groups`}
        </Button>
      }
      description={t`The brain's regions: your teams, grouped the way your company is. Grasp can propose groups; they count once you confirm them.`}
      title={t`Groups of teams`}
    >
      {teams.length === 0 ? (
        <Text tone="muted">{t`The brain has no teams to group yet.`}</Text>
      ) : (
        <SettingsStack>
          <div {...stylex.props(styles.part)}>
            <Heading level={3} size="ui">
              {t`Groups`}
            </Heading>
            {groups.map((group) => (
              <div key={group.id} {...stylex.props(styles.group)}>
                <div {...stylex.props(styles.name)}>
                  <Input
                    aria-label={t`Group name`}
                    disabled={busy}
                    maxLength={80}
                    onValueChange={(value) => {
                      setGroups(
                        groups.map((each) =>
                          each.id === group.id ? { ...each, name: value } : each
                        )
                      );
                    }}
                    value={group.name}
                  />
                </div>
                {held.some(
                  ({ id, confirmed }) => id === group.id && !confirmed
                ) ? (
                  <Badge tone="info">{t`Proposed`}</Badge>
                ) : null}
              </div>
            ))}
            <div>
              <Button
                disabled={busy}
                icon={Plus}
                onClick={() => {
                  setGroups([
                    ...groups,
                    { id: newGroupId(), name: t`New group`, teamIds: [] },
                  ]);
                }}
                size="sm"
                variant="ghost"
              >
                {t`Add a group`}
              </Button>
            </div>
          </div>
          <div {...stylex.props(styles.part)}>
            <Heading level={3} size="ui">
              {t`Teams`}
            </Heading>
            <ItemGroup aria-label={t`Teams`} separated>
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
            </ItemGroup>
          </div>
          {failure === undefined ? null : (
            <Alert variant="danger">{failure}</Alert>
          )}
          <div {...stylex.props(styles.foot)}>
            {proposed ? (
              <Text size="sm" tone="muted">
                {t`Grasp’s proposal counts once you confirm it.`}
              </Text>
            ) : null}
            <Button disabled={busy || unnamed} onClick={confirm} variant="ink">
              {t`Confirm groups`}
            </Button>
          </div>
        </SettingsStack>
      )}
    </SectionCard>
  );
};

const BrainSettings = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  if (page.state !== "ready") {
    return (
      <SectionCard title={t`Groups of teams`}>
        <SectionNotLoaded page={page} />
      </SectionCard>
    );
  }
  const { teams, teamGroups } = page.data;
  return (
    <TeamGroups
      held={teamGroups}
      // Read again after a proposal or a save: the groups as core kept
      // them, any change not confirmed set aside.
      key={teamGroups
        .map(({ id, name, teamIds, confirmed }) =>
          [id, name, teamIds.join(","), confirmed].join(":")
        )
        .join("|")}
      teams={teams}
    />
  );
};

export const Route = createFileRoute("/_shell/settings/brain")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: BrainSettings,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => {
      const { teams, teamGroups } = await session.brain.read();
      return { teams, teamGroups };
    }),
});
