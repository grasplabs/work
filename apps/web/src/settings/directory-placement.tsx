import type {
  DirectoryMover,
  DirectoryPlacement,
  OrganizationTeam,
  PlacedMember,
  TeamName,
  TeamPin,
  UnplacedMember,
} from "@grasp-os/shared/members";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDate } from "../format.ts";
import { initials } from "../frame/person-menu.tsx";
import { useCore } from "../use-core.ts";
import { SettingsSection } from "./settings-parts.tsx";
import { addTeamMember, removeTeamMember } from "./team-changes.ts";
import { useTeamChange } from "./use-team-change.ts";

// What the directory leaves for an admin to place, and what admins placed
// by hand (GRA-2056, slice 4; core's directory-placement.ts), under the
// teams in Settings › Members › Teams: members in no team, members still
// in a team the directory's read put them in that their department no
// longer fills (GRA-2135), and every hand pin. Placing and taking off go
// through the same team routes as anywhere else, which pin the pair;
// letting the directory decide again releases a pin. Each section shows
// only while it lists someone.

/** What the directory says of someone's department, in one sentence. */
const DirectorySays = ({
  department,
  departmentTeam,
}: {
  department: string | null;
  departmentTeam: TeamName | null;
}) => {
  if (department === null) {
    return <Trans>Not in the directory.</Trans>;
  }
  if (department === "") {
    return <Trans>The directory gives no department.</Trans>;
  }
  if (departmentTeam === null) {
    return (
      <Trans>
        The directory gives the department “{department}”, which no team is
        linked to.
      </Trans>
    );
  }
  const team = departmentTeam.name;
  return (
    <Trans>
      The directory gives the department “{department}”, which is linked to{" "}
      {team}.
    </Trans>
  );
};

/** One person's row: who they are, what is said of them, and what to do. */
const PersonRow = ({
  person,
  children,
  actions,
}: {
  person: PlacedMember;
  children: ReactNode;
  actions: ReactNode;
}) => (
  <div className="flex flex-wrap items-center gap-3 border-t px-5 py-3">
    <Avatar className="size-8">
      <AvatarFallback>{initials(person.name)}</AvatarFallback>
    </Avatar>
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{person.name}</span>
      <span className="text-muted-foreground truncate">{person.email}</span>
      <span className="text-muted-foreground">{children}</span>
    </div>
    <div className="flex flex-col items-end gap-1">{actions}</div>
  </div>
);

/** Adding `person` to a team they aren't in, chosen from `teams`. */
const AddToTeam = ({
  person,
  teams,
  except,
  onChanged,
}: {
  person: PlacedMember;
  teams: readonly OrganizationTeam[];
  /** A team they are in already, not offered. */
  except?: string;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const [chosen, setChosen] = useState<string | null>(null);
  const { busy, failure, run } = useTeamChange(onChanged);
  const items = teams
    .filter((team) => team.id !== except)
    .map((team) => ({ value: team.id, label: team.name }));
  const picked = items.some((item) => item.value === chosen) ? chosen : null;
  const who = person.name;
  if (items.length === 0) {
    return null;
  }
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (picked !== null) {
          void run(
            async () => {
              await addTeamMember(picked, person.userId);
            },
            t`${who} couldn't be added to the team. Try again.`
          );
        }
      }}
    >
      <Select
        items={items}
        onValueChange={(value: string | null) => {
          setChosen(value);
        }}
        value={picked}
      >
        <SelectTrigger aria-label={t`Team for ${who}`} className="w-44">
          <SelectValue placeholder={t`Choose a team`} />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button disabled={busy || picked === null} size="sm" type="submit">
        <Trans>Add</Trans>
      </Button>
      <ErrorText>{failure}</ErrorText>
    </form>
  );
};

/** Members who may act and are in no team. */
const Unplaced = ({
  people,
  teams,
  onChanged,
}: {
  people: readonly UnplacedMember[];
  teams: readonly OrganizationTeam[];
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const count = people.length;
  if (count === 0) {
    return null;
  }
  return (
    <SettingsSection
      action={
        <Badge variant="attention">
          <Plural one="# to place" other="# to place" value={count} />
        </Badge>
      }
      description={t`They can use Grasp, but nothing shared with a team reaches them. Add each to a team: the directory’s daily read leaves a team you chose as it is.`}
      title={t`Not in a team`}
    >
      {people.map((person) => (
        <PersonRow
          actions={
            <AddToTeam onChanged={onChanged} person={person} teams={teams} />
          }
          key={person.userId}
          person={person}
        >
          <DirectorySays
            department={person.department}
            departmentTeam={person.departmentTeam}
          />
        </PersonRow>
      ))}
    </SettingsSection>
  );
};

/** Taking `person` off `team` by hand. */
const TakeOff = ({
  person,
  team,
  onChanged,
}: {
  person: PlacedMember;
  team: TeamName;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useTeamChange(onChanged);
  const who = person.name;
  const { name } = team;
  return (
    <>
      <Button
        disabled={busy}
        onClick={() => {
          void run(
            async () => {
              await removeTeamMember(team.id, person.userId);
            },
            t`${who} couldn't be taken off ${name}. Try again.`
          );
        }}
        size="sm"
        variant="outline"
      >
        <Trans>Take off {name}</Trans>
      </Button>
      <ErrorText>{failure}</ErrorText>
    </>
  );
};

/** Members in a team the read made that their department no longer fills. */
const Movers = ({
  movers,
  teams,
  onChanged,
}: {
  movers: readonly DirectoryMover[];
  teams: readonly OrganizationTeam[];
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const count = movers.length;
  if (count === 0) {
    return null;
  }
  return (
    <SettingsSection
      action={
        <Badge variant="attention">
          <Plural one="# to check" other="# to check" value={count} />
        </Badge>
      }
      description={t`The directory put them in a team their department there no longer fills. Its daily read moves someone only into the team their department fills, so they stay until you take them off or add them to the right team.`}
      title={t`Team doesn’t match the directory`}
    >
      {movers.map((mover) => {
        const team = mover.team.name;
        return (
          <PersonRow
            actions={
              <>
                <TakeOff
                  onChanged={onChanged}
                  person={mover}
                  team={mover.team}
                />
                <AddToTeam
                  except={mover.team.id}
                  onChanged={onChanged}
                  person={mover}
                  teams={teams}
                />
              </>
            }
            key={`${mover.userId} ${mover.team.id}`}
            person={mover}
          >
            <Trans>In {team} from the directory.</Trans>{" "}
            <DirectorySays
              department={mover.department}
              departmentTeam={mover.departmentTeam}
            />
          </PersonRow>
        );
      })}
    </SettingsSection>
  );
};

/** A pin, and letting the directory decide that pair again. */
const PinRow = ({
  pin,
  onChanged,
}: {
  pin: TeamPin;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const { busy, failure, run } = useTeamChange(onChanged);
  const team = pin.team.name;
  const date = formatDate(pin.pinnedAt);
  const who = pin.name;
  return (
    <PersonRow
      actions={
        <>
          <Button
            aria-label={t`Let the directory decide whether ${who} is in ${team}`}
            disabled={busy}
            onClick={() => {
              void run(
                async () => {
                  await core.withSession(
                    async (session) =>
                      await session.members.releaseTeamPin(
                        pin.userId,
                        pin.team.id
                      )
                  );
                },
                t`The pin on ${who} couldn't be released. Try again.`
              );
            }}
            size="sm"
            variant="outline"
          >
            <Trans>Let the directory decide</Trans>
          </Button>
          <ErrorText>{failure}</ErrorText>
        </>
      }
      person={pin}
    >
      {pin.kept ? (
        <Trans>
          Kept in {team} by hand since {date}.
        </Trans>
      ) : (
        <Trans>
          Kept out of {team} by hand since {date}.
        </Trans>
      )}
    </PersonRow>
  );
};

/** Every hand pin on a member tied to the directory. */
const Pins = ({
  pins,
  onChanged,
}: {
  pins: readonly TeamPin[];
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  if (pins.length === 0) {
    return null;
  }
  return (
    <SettingsSection
      description={t`An admin put them in a team, or took them off one, by hand, and the directory’s daily read leaves that as it is. Letting the directory decide takes the pin away: from its next read, the directory may add them to that team, or take them off it if it put them there.`}
      title={t`Placed by hand`}
    >
      {pins.map((pin) => (
        <PinRow
          key={`${pin.userId} ${pin.team.id}`}
          onChanged={onChanged}
          pin={pin}
        />
      ))}
    </SettingsSection>
  );
};

/** Who the directory leaves for an admin to place, and the hand pins. */
export const DirectoryPlacementSections = ({
  placement,
  teams,
  onChanged,
}: {
  placement: DirectoryPlacement;
  teams: readonly OrganizationTeam[];
  onChanged: () => Promise<void>;
}) => (
  <>
    <Unplaced onChanged={onChanged} people={placement.unplaced} teams={teams} />
    <Movers movers={placement.movers} onChanged={onChanged} teams={teams} />
    <Pins onChanged={onChanged} pins={placement.pins} />
  </>
);
