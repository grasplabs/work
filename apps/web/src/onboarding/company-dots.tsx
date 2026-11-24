// Concept A, not for merging yet: the company in dots. Stephen draws the
// staff list as the brand draws, a square for every person, piled team by
// team on one ground line, in the campaign page's pixel material
// (campaign/pixels.ts). Each team is one button: under the pointer or the
// keyboard's focus its squares come into the light, the brand's dither
// round them, and the line under the picture says who is in it. The
// people the step names stand in the field's mint. A press keeps a team
// shown, for a screen that has no pointer to hover with.
import type { Roster } from "@grasp-os/shared/onboarding";
import { Text } from "@grasp-os/ui/components/text";
import { focusRing } from "@grasp-os/ui/lib/styles";
import { media, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { formatList } from "../format.ts";
import { bayerAt, usePixels } from "./campaign/pixels.ts";
import type { Put } from "./campaign/pixels.ts";
import { namedOf, teamsOf } from "./company-picture.ts";
import type { TeamPicture } from "./company-picture.ts";

/** The drawing's cell in pixels, a person's square in cells, and the light's room round a team. */
const CELL = 3;
const SIDE = 4;
const PITCH = SIDE + 1;
const HALO = 4;

/** How many of a team the line names; the rest it counts. */
const shownMost = 8;

/** How many a row, at most `most`, so every row holds about as many. */
const evenRows = (count: number, most: number): number =>
  Math.max(1, Math.ceil(count / Math.ceil(count / most)));

/** A team's pile: as wide as it is high, near enough; never narrower than two. */
const pileOf = (count: number) => {
  const wide = Math.max(2, Math.ceil(Math.sqrt(count)));
  const high = Math.max(1, Math.ceil(count / wide));
  return {
    wide,
    high,
    columns: HALO * 2 + wide * PITCH - 1,
    rows: HALO * 2 + high * PITCH - 1,
  };
};

const styles = stylex.create({
  picture: { display: "grid", gap: space[8] },
  // Rows of even length, never a full row and a stray one: up to four a row, three on a phone.
  teams: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(var(--wide), minmax(0, 1fr))",
      [media.maxSm]: "repeat(var(--narrow), minmax(0, 1fr))",
    },
    justifyContent: "center",
    alignItems: "start",
    columnGap: { default: space[2], [media.maxSm]: space[1] },
    rowGap: space[6],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  across: (wide: number, narrow: number) => ({
    "--wide": wide,
    "--narrow": narrow,
  }),
  team: {
    width: "100%",
    display: "grid",
    justifyItems: "center",
    gap: space[2],
    margin: 0,
    paddingBlock: space[2],
    paddingInline: space[3],
    borderWidth: 0,
    borderRadius: radius.lg,
    cornerShape: radius.shape,
    cursor: "pointer",
    color: "inherit",
    backgroundColor: "transparent",
  },
  // Every pile stands on the same ground: the drawing's room is the tallest pile's.
  ground: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
  },
  groundHigh: (height: number) => ({ height: `${height}px` }),
  canvas: (width: number, height: number) => ({
    display: "block",
    width: `${width}px`,
    height: `${height}px`,
    imageRendering: "pixelated",
  }),
  words: { display: "grid", justifyItems: "center", maxWidth: "10rem" },
  // The line under the picture: room for two lines, so the page doesn't jump as it changes.
  line: { minHeight: "3.5rem", textAlign: "center" },
});

/**
 * One team's pile: a square for every person, from the ground up, the
 * top row in the middle. Lit, its squares in full ink with the brand's
 * dither round them; else quieter. The named are mint either way.
 */
const drawPile =
  (count: number, named: ReadonlySet<number>, lit: boolean) =>
  (columns: number, rows: number, put: Put) => {
    const { wide, high } = pileOf(count);
    const left = HALO;
    const top = HALO;
    const right = columns - HALO;
    const bottom = rows - HALO;
    if (lit) {
      for (let x = 0; x < columns; x += 1) {
        for (let y = 0; y < rows; y += 1) {
          const out = Math.max(
            left - x,
            x - right + 1,
            top - y,
            y - bottom + 1,
            0
          );
          const near = 1 - out / (HALO + 1);
          // Round the pile, never between its squares, so each person stays one square.
          if (out > 0 && bayerAt(x, y) < 0.12 + 0.4 * near * near) {
            put(x, y, "sea");
          }
        }
      }
    }
    // The ground the pile stands on, as the campaign's week has it.
    for (let x = 1; x < columns - 1; x += 1) {
      put(x, bottom + 1, "border");
    }
    for (let index = 0; index < count; index += 1) {
      const row = Math.floor(index / wide);
      const inRow = Math.min(wide, count - row * wide);
      // A row short of full stands in the middle of the pile.
      const offset = Math.floor(((wide - inRow) * PITCH) / 2);
      const x = left + offset + (index % wide) * PITCH;
      const y = top + (high - 1 - row) * PITCH;
      let tone: "mint" | "foreground" | "muted-foreground" = lit
        ? "foreground"
        : "muted-foreground";
      if (named.has(index)) {
        tone = "mint";
      }
      for (let dx = 0; dx < SIDE; dx += 1) {
        for (let dy = 0; dy < SIDE; dy += 1) {
          put(x + dx, y + dy, tone);
        }
      }
    }
  };

const Pile = ({
  count,
  named,
  lit,
}: {
  count: number;
  named: ReadonlySet<number>;
  lit: boolean;
}) => {
  const canvas = usePixels(CELL, drawPile(count, named, lit));
  const { columns, rows } = pileOf(count);
  return (
    <canvas
      aria-hidden
      ref={canvas}
      {...stylex.props(styles.canvas(columns * CELL, rows * CELL))}
    />
  );
};

/** What the line under the picture says of a team: its people by name, the rest counted. */
const usePeopleLine = (team: TeamPicture): string => {
  const { t } = useLingui();
  const names = team.people
    .map(({ name }) => name)
    .filter((name) => name !== "");
  const more = names.length - shownMost;
  const shown =
    more > 0
      ? [
          ...names.slice(0, shownMost),
          plural(more, { one: "# other", other: "# others" }),
        ]
      : names;
  const everyone = formatList(shown);
  const { name } = team;
  return t`In ${name}: ${everyone}.`;
};

const PeopleLine = ({ team }: { team: TeamPicture }) => (
  <Text>{usePeopleLine(team)}</Text>
);

export const CompanyDots = ({ roster }: { roster: Roster }) => {
  const { t } = useLingui();
  const teams = teamsOf(roster);
  const named = namedOf(roster);
  const namedIds = new Set(named.map(({ id }) => id));
  // The team under the pointer or the focus, and the one a press keeps.
  const [hovered, setHovered] = useState<string | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  const shownId = hovered ?? kept;
  const shown = teams.find((team) => team.id === shownId) ?? null;
  const tallest = Math.max(
    ...teams.map((team) => pileOf(team.people.length).rows)
  );
  const names = formatList(named.map(({ name }) => name));
  const leave = (id: string) => {
    setHovered((current) => (current === id ? null : current));
  };
  return (
    <div {...stylex.props(styles.picture)}>
      <ul
        aria-label={t`Your teams`}
        {...stylex.props(
          styles.teams,
          styles.across(evenRows(teams.length, 4), evenRows(teams.length, 3))
        )}
      >
        {teams.map((team) => {
          const count = team.people.length;
          const namedHere = new Set(
            team.people.flatMap((person, index) =>
              namedIds.has(person.id) ? [index] : []
            )
          );
          const people = plural(count, { one: "# person", other: "# people" });
          const lit = shownId === team.id;
          return (
            <li key={team.id}>
              <button
                aria-pressed={kept === team.id}
                onBlur={() => {
                  leave(team.id);
                }}
                onClick={() => {
                  setKept((current) => (current === team.id ? null : team.id));
                }}
                onFocus={() => {
                  setHovered(team.id);
                }}
                onPointerEnter={() => {
                  setHovered(team.id);
                }}
                onPointerLeave={() => {
                  leave(team.id);
                }}
                type="button"
                {...stylex.props(styles.team, focusRing)}
              >
                <span
                  {...stylex.props(
                    styles.ground,
                    styles.groundHigh(tallest * CELL)
                  )}
                >
                  <Pile count={count} lit={lit} named={namedHere} />
                </span>
                <span {...stylex.props(styles.words)}>
                  <Text as="span" color="default">
                    {team.name}
                  </Text>
                  <Text as="span">{people}</Text>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div aria-live="polite" {...stylex.props(styles.line)}>
        {shown === null && named.length > 0 ? (
          <Text>{t`Among them ${names}.`}</Text>
        ) : null}
        {shown === null ? null : <PeopleLine key={shown.id} team={shown} />}
      </div>
    </div>
  );
};
