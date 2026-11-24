// Concept B, not for merging yet: the teams as rows. One list, a team a
// row, as the integrations are listed: its name, how many people and who
// leads it, and at the row's end a strip of the campaign page's pixel
// squares (campaign/pixels.ts), one a person, the lead's in the field's
// mint. A long list scrolls in its own room, so the way on stays in view.
import type { Roster } from "@grasp-os/shared/onboarding";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemSeparator,
} from "@grasp-os/ui/components/item";
import { Text } from "@grasp-os/ui/components/text";
import { media } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Fragment } from "react";

import { usePixels } from "./campaign/pixels.ts";
import type { Put } from "./campaign/pixels.ts";
import { teamsOf } from "./company-picture.ts";

/** The strip's cell in pixels, a person's square in cells, and how many squares a line holds. */
const CELL = 3;
const SIDE = 3;
const PITCH = SIDE + 1;
const LINE = 20;

const styles = stylex.create({
  // Room for about eight rows; a longer list scrolls inside it.
  room: { maxHeight: "42rem", overflowY: "auto" },
  // On a phone the strip drops under the words: there it starts on their edge, not the row's end.
  strip: { marginInlineStart: { default: "auto", [media.maxSm]: 0 } },
  canvas: (width: number, height: number) => ({
    display: "block",
    width: `${width}px`,
    height: `${height}px`,
    imageRendering: "pixelated",
  }),
});

/** A team's strip: a square a person, a line of twenty at most, the lead's first and mint. */
const drawStrip =
  (count: number, lead: boolean) =>
  (_columns: number, _rows: number, put: Put) => {
    for (let index = 0; index < count; index += 1) {
      const x = (index % LINE) * PITCH;
      const y = Math.floor(index / LINE) * PITCH;
      const tone = lead && index === 0 ? "mint" : "foreground";
      for (let dx = 0; dx < SIDE; dx += 1) {
        for (let dy = 0; dy < SIDE; dy += 1) {
          put(x + dx, y + dy, tone);
        }
      }
    }
  };

const Strip = ({
  count,
  lead,
  wide,
}: {
  count: number;
  lead: boolean;
  /** As many squares across as the longest strip of the list, so every strip starts on one edge. */
  wide: number;
}) => {
  const canvas = usePixels(CELL, drawStrip(count, lead));
  const lines = Math.max(1, Math.ceil(count / LINE));
  return (
    <canvas
      aria-hidden
      ref={canvas}
      {...stylex.props(
        styles.canvas((wide * PITCH - 1) * CELL, (lines * PITCH - 1) * CELL)
      )}
    />
  );
};

export const CompanyRows = ({ roster }: { roster: Roster }) => {
  const { t } = useLingui();
  const teams = teamsOf(roster);
  const wide = Math.min(
    LINE,
    Math.max(1, ...teams.map((team) => team.people.length))
  );
  return (
    <div {...stylex.props(styles.room)}>
      <ItemGroup aria-label={t`Your teams`}>
        {teams.map((team, index) => {
          const count = team.people.length;
          const { lead } = team;
          const about =
            lead === null
              ? plural(count, { one: "# person", other: "# people" })
              : plural(count, {
                  one: `# person, led by ${lead}`,
                  other: `# people, led by ${lead}`,
                });
          return (
            <Fragment key={team.id}>
              {index === 0 ? null : <ItemSeparator />}
              <Item size="sm">
                <ItemContent>
                  <Text color="default">{team.name}</Text>
                  <Text>{about}</Text>
                </ItemContent>
                <ItemActions style={styles.strip}>
                  <Strip count={count} lead={lead !== null} wide={wide} />
                </ItemActions>
              </Item>
            </Fragment>
          );
        })}
      </ItemGroup>
    </div>
  );
};
