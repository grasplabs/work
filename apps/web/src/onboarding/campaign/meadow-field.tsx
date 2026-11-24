// Concepts only: the campaign as the brand's meadow ("Transformation
// starts small, and grows"), drawn still, in pixels. Every person invited
// is a seed in their team's stretch of ground; once they have talked, it
// has grown into a flower. A team under five shows only its lead's flower.
// The sky lightens towards dawn with how much Grasp knows. A quiet team is
// a bare stretch, which says what the page means without a word.
import { Card } from "@grasp-os/ui/components/card";
import { Text } from "@grasp-os/ui/components/text";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

import { talkedWords } from "./campaign-words.ts";
import { smallTeam } from "./fixtures.ts";
import type { Campaign, TeamPicture } from "./fixtures.ts";
import { bayerAt, hash, seeded, usePixels } from "./pixels.ts";
import type { Put, Stop } from "./pixels.ts";

const styles = stylex.create({
  canvas: {
    display: "block",
    width: "100%",
    height: { default: "22rem", [media.maxSm]: "12rem" },
    imageRendering: "pixelated",
  },
  figure: {
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    margin: 0,
  },
  // Wide, each name stands under its own stretch of ground; on a phone they wrap in a row.
  labels: {
    display: { default: "grid", [media.maxMd]: "none" },
    columnGap: space[2],
  },
  // On a phone the meadow stands alone: the names are for a larger screen.
  wrapped: {
    display: {
      default: "none",
      "@media (40rem <= width < 48rem)": "flex",
    },
    flexWrap: "wrap",
    columnGap: space[5],
    rowGap: space[2],
  },
  columns: (template: string) => ({ gridTemplateColumns: template }),
  label: { display: "flex", flexDirection: "column", minWidth: 0 },
});

/** How many of a team's seeds have flowered, as the admin may see it. */
/** A team's share of the ground: never so narrow that its name can't stand under it. */
const groundOf = (team: TeamPicture): number => Math.max(team.invited, 6);

export const grownOf = (team: TeamPicture): number => {
  if (team.invited < smallTeam) {
    return team.leadTalked ? 1 : 0;
  }
  return team.talked;
};

const GROUND_ROWS = 3;
const heads: Stop[] = ["mint", "sea", "lime", "paper", "mint", "sea"];

const sky = (put: Put, columns: number, horizon: number, dawn: number) => {
  for (let y = 0; y < horizon; y += 1) {
    const near = 1 - (horizon - y) / horizon;
    // The dawn rises from the horizon, never past its lower half.
    const glow = dawn * 0.75 * near ** 3.2;
    for (let x = 0; x < columns; x += 1) {
      put(x, y, "night");
      const threshold = bayerAt(x, y);
      if (glow > threshold) {
        put(x, y, "pine", 0.55);
      }
      if (glow > threshold + 0.45) {
        put(x, y, "mint", 0.3);
      }
      const star = hash(x, y, 7);
      if (y < horizon * 0.45 && star < 0.006) {
        put(x, y, "paper", 0.25 + star * 60);
      }
    }
  }
};

const ground = (put: Put, columns: number, rows: number, horizon: number) => {
  for (let y = horizon; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      put(x, y, "ink");
      if (y === horizon && hash(x, y, 3) < 0.55) {
        put(x, y, "pine", 0.8);
      } else if (y > horizon && bayerAt(x, y) < 0.3) {
        put(x, y, "pine", 0.35);
      }
    }
  }
};

/** One flower: a stem, two leaves, and a head in one of the light's stops. */
const flower = (
  put: Put,
  x: number,
  horizon: number,
  tall: number,
  head: Stop
) => {
  for (let k = 1; k <= tall; k += 1) {
    put(x, horizon - k, "mint", 0.55);
  }
  const leaf = Math.max(2, Math.floor(tall / 2));
  put(x - 1, horizon - leaf, "mint", 0.8);
  put(x + 1, horizon - leaf - 1, "mint", 0.8);
  const top = horizon - tall - 1;
  put(x, top - 1, head);
  put(x - 1, top, head);
  put(x + 1, top, head);
  put(x, top + 1, head, 0.7);
  put(x, top, "lime");
};

/** The meadow, one stretch of ground per team, in proportion to how many were invited. */
const drawMeadow =
  (teams: TeamPicture[], dawn: number) =>
  (columns: number, rows: number, put: Put) => {
    const horizon = rows - GROUND_ROWS;
    sky(put, columns, horizon, dawn);
    ground(put, columns, rows, horizon);
    const total = teams.reduce((sum, each) => sum + groundOf(each), 0);
    let start = 0;
    for (const [index, team] of teams.entries()) {
      const width = Math.round((groundOf(team) / total) * columns);
      const random = seeded(index * 31 + 5);
      const grown = grownOf(team);
      for (let i = 0; i < team.invited; i += 1) {
        const jitter = Math.round((random() - 0.5) * 2);
        const x = Math.min(
          columns - 2,
          Math.max(
            1,
            start + Math.floor(((i + 0.5) * width) / team.invited) + jitter
          )
        );
        const tall = 4 + Math.floor(random() * (horizon * 0.45));
        const head = heads[Math.floor(random() * heads.length)] ?? "mint";
        if (i < grown) {
          flower(put, x, horizon, Math.min(tall, horizon - 4), head);
        } else {
          // A seed in the ground, waiting.
          put(x, horizon, "sea", 0.55);
        }
      }
      start += width;
    }
  };

const TeamLabel = ({ team }: { team: TeamPicture }) => (
  <span {...stylex.props(styles.label)}>
    <Text size="lg" as="span" truncate>
      {team.name}
    </Text>
    <Text size="lg" as="span" color="muted" truncate>
      {talkedWords(team, true)}
    </Text>
  </span>
);

/** The meadow, with each team's name and count under its stretch (none for a company without teams). */
export const MeadowField = ({
  campaign,
  label,
}: {
  campaign: Campaign;
  label: string;
}) => {
  const { teams, grouped, known } = campaign;
  // Finer on a phone, so the meadow keeps its room between flowers.
  const canvas = usePixels(
    (width) => (width < 600 ? 4 : 6),
    drawMeadow(teams, known / 100)
  );
  const template = teams.map((each) => `${groundOf(each)}fr`).join(" ");
  return (
    <figure {...stylex.props(styles.figure)}>
      <Card padding="none">
        <span {...stylex.props(visuallyHidden)}>{label}</span>
        <canvas aria-hidden ref={canvas} {...stylex.props(styles.canvas)} />
      </Card>
      {grouped ? (
        <figcaption>
          <span {...stylex.props(styles.labels, styles.columns(template))}>
            {teams.map((each) => (
              <TeamLabel key={each.id} team={each} />
            ))}
          </span>
          <span {...stylex.props(styles.wrapped)}>
            {teams.map((each) => (
              <TeamLabel key={each.id} team={each} />
            ))}
          </span>
        </figcaption>
      ) : null}
    </figure>
  );
};
