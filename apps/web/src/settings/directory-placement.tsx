import type {
  DirectoryMover,
  DirectoryPlacement,
  OrganizationTeam,
  PlacedMember,
  TeamName,
  TeamPin,
  UnplacedMember,
} from "@grasp-os/shared/members";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDate } from "../format.ts";
import { Avatar, AvatarFallback } from "../grasp/avatar/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCore } from "../use-core.ts";
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

const styles = stylex.create({
  actions: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: grasp.space1,
  },
  add: { display: "flex", alignItems: "center", gap: grasp.space2 },
});

/** A section of people to place: a compact card, a row each. */
const PlacementSection = ({
  title,
  description,
  aside,
  label,
  children,
}: {
  title: string;
  description: string;
  aside?: ReactNode;
  label: string;
  children: ReactNode;
}) => (
  <SectionCard
    aside={aside}
    density="compact"
    description={description}
    flush
    title={title}
    variant="grouped"
  >
    <ItemGroup aria-label={label} separated>
      {children}
    </ItemGroup>
  </SectionCard>
);

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
  <Item size="xs">
    <ItemMedia>
      <Avatar decorative name={person.name} size="sm">
        <AvatarFallback />
      </Avatar>
    </ItemMedia>
    <ItemContent>
      <ItemTitle>{person.name}</ItemTitle>
      <ItemDescription>{person.email}</ItemDescription>
      <ItemDescription>{children}</ItemDescription>
    </ItemContent>
    <ItemActions>
      <div {...stylex.props(styles.actions)}>{actions}</div>
    </ItemActions>
  </Item>
);

/**
 * Adding `person` to a team they aren't in, chosen from `teams`. A team
 * they are in already isn't offered: adding them again would only pin
 * that membership (auth.ts's before hook), not move them.
 */
const AddToTeam = ({
  person,
  teams,
  onChanged,
}: {
  person: PlacedMember;
  teams: readonly OrganizationTeam[];
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const [chosen, setChosen] = useState<string | null>(null);
  const { busy, failure, run } = useTeamChange(onChanged);
  const items = teams
    .filter((team) => !team.memberIds.includes(person.userId))
    .map((team) => ({ value: team.id, label: team.name }));
  const picked = items.some((item) => item.value === chosen) ? chosen : null;
  const who = person.name;
  if (items.length === 0) {
    return null;
  }
  return (
    <form
      {...stylex.props(styles.add)}
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
        <SelectTrigger aria-label={t`Team for ${who}`} size="sm">
          <SelectValue placeholder={t`Choose a team`} />
        </SelectTrigger>
        <SelectContent />
      </Select>
      <Button
        disabled={picked === null || busy}
        size="sm"
        type="submit"
        variant="quiet"
      >
        {t`Add`}
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
    <PlacementSection
      aside={
        <Badge size="sm" tone="attention">
          {plural(count, { one: "# to place", other: "# to place" })}
        </Badge>
      }
      description={t`Nothing shared with a team reaches them yet. Add each to one, and the directory keeps your choice.`}
      label={t`Not in a team`}
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
    </PlacementSection>
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
        variant="quiet"
      >
        {t`Take off ${name}`}
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
    <PlacementSection
      aside={
        <Badge size="sm" tone="attention">
          {plural(count, { one: "# to check", other: "# to check" })}
        </Badge>
      }
      description={t`Their department in the directory no longer fills this team. They stay until you move them.`}
      label={t`Team doesn’t match the directory`}
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
                <AddToTeam onChanged={onChanged} person={mover} teams={teams} />
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
    </PlacementSection>
  );
};

/**
 * A pin, and what undoes it. Kept out: letting the directory decide again,
 * whose next read adds them where their department says. Kept in: taking
 * them off by hand, since the read never takes away a membership it didn't
 * make, so releasing it would change nothing.
 */
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
  const release = (
    <>
      <Button
        disabled={busy}
        aria-label={t`Let the directory decide whether ${who} is in ${team}`}
        onClick={() => {
          void run(
            async () => {
              await core.withSession(
                async (session) =>
                  await session.members.releaseTeamPin(pin.userId, pin.team.id)
              );
            },
            t`The pin on ${who} couldn't be released. Try again.`
          );
        }}
        size="sm"
        variant="quiet"
      >
        {t`Let the directory decide`}
      </Button>
      <ErrorText>{failure}</ErrorText>
    </>
  );
  return (
    <PersonRow
      actions={
        pin.kept ? (
          <TakeOff onChanged={onChanged} person={pin} team={pin.team} />
        ) : (
          release
        )
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
    <PlacementSection
      description={t`An admin set these by hand, and the directory leaves them as they are.`}
      label={t`Placed by hand`}
      title={t`Placed by hand`}
    >
      {pins.map((pin) => (
        <PinRow
          key={`${pin.userId} ${pin.team.id}`}
          onChanged={onChanged}
          pin={pin}
        />
      ))}
    </PlacementSection>
  );
};

/**
 * Who the directory leaves for an admin to place, and the hand pins, as
 * the Teams tab read them with its teams (and reads again after every
 * change): mounted there with one line.
 */
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
