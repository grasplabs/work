import type { Team, TeamGroup } from "@grasp-os/shared/brain";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PlusIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import {
  SettingsBody,
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Settings → Brain: the company's groups of teams, the brain's regions
// (core's brain-team-groups.ts). The prototype keeps its groups as data
// and has no screen for them; this one is in its settings' language: a
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
    <li className="flex items-center justify-between gap-4 py-1">
      <span className="min-w-0 truncate">{name}</span>
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
        <SelectTrigger aria-label={t`Group of ${name}`} className="w-48">
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
    </li>
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
    <SettingsSection
      action={
        <Button
          disabled={busy || teams.length === 0}
          onClick={propose}
          size="sm"
          variant="outline"
        >
          <SparklesIcon data-icon="inline-start" />
          <Trans>Propose groups</Trans>
        </Button>
      }
      description={t`The brain's regions: your teams, grouped the way your company is. Grasp can propose groups; they count once you confirm them.`}
      title={t`Groups of teams`}
    >
      {teams.length === 0 ? (
        <SettingsBody>
          <p className="text-muted-foreground">
            <Trans>The brain has no teams to group yet.</Trans>
          </p>
        </SettingsBody>
      ) : (
        <>
          <SettingsBody>
            {groups.map((group) => (
              <div className="flex items-center gap-2" key={group.id}>
                <Input
                  aria-label={t`Group name`}
                  disabled={busy}
                  maxLength={80}
                  onChange={(event) => {
                    const { value } = event.target;
                    setGroups(
                      groups.map((each) =>
                        each.id === group.id ? { ...each, name: value } : each
                      )
                    );
                  }}
                  value={group.name}
                />
                {held.some(
                  ({ id, confirmed }) => id === group.id && !confirmed
                ) ? (
                  <Badge variant="secondary">
                    <Trans>Proposed</Trans>
                  </Badge>
                ) : null}
              </div>
            ))}
            <div>
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
                <PlusIcon data-icon="inline-start" />
                <Trans>Add a group</Trans>
              </Button>
            </div>
          </SettingsBody>
          <SettingsBody>
            <ul aria-label={t`Teams`} className="flex flex-col">
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
            </ul>
          </SettingsBody>
          <div className="flex flex-wrap items-center justify-end gap-3 border-t px-5 py-3">
            <ErrorText>{failure}</ErrorText>
            {proposed ? (
              <span className="text-muted-foreground">
                <Trans>Grasp’s proposal counts once you confirm it.</Trans>
              </span>
            ) : null}
            <Button disabled={busy || unnamed} onClick={confirm} size="sm">
              <Trans>Confirm groups</Trans>
            </Button>
          </div>
        </>
      )}
    </SettingsSection>
  );
};

const BrainSettings = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  if (page.state !== "ready") {
    return (
      <SettingsSection title={t`Groups of teams`}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsSection>
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
