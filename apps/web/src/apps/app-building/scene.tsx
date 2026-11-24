// The drawing on App building's stage: the pieces standing at this step and the cursors over them.
// It draws what plan.ts says; it holds no state of its own.
import { Icon, MousePointerIcon } from "@grasp-os/ui/lib/icons";
import * as stylex from "@stylexjs/stylex";

import { kindStyles, Parts } from "./parts.tsx";
import type { Hand, Shown } from "./plan.ts";
import { blocks, fills, styles, tones } from "./styles.ts";

interface SceneProps {
  shown: readonly Shown[];
  hands: readonly Hand[];
  names: readonly string[];
  /** Reduced motion: nothing moves in. */
  still: boolean;
  /** The round, so a new round's pieces come in afresh. */
  round: number;
  /** The step, so each press draws its ring afresh. */
  step: number;
}

const Cursor = ({
  hand,
  name,
  tone,
  ring,
}: {
  hand: Hand;
  name: string;
  tone: number;
  ring: string;
}) => (
  <span
    data-slot="app-building-cursor"
    {...stylex.props(styles.track, styles.to(hand.x, hand.y))}
  >
    <span {...stylex.props(styles.cursor, tones[tone % tones.length])}>
      {/* MousePointerIcon points along the line (src/icons `pointing`): the icon turns round itself right
            to left, marked so (data-mirror), and its tip still leads its name. */}
      <Icon icon={MousePointerIcon} />
      {hand.pressing ? (
        <span key={ring} {...stylex.props(styles.ring)} />
      ) : null}
      <span {...stylex.props(styles.tag, fills[tone % fills.length])}>
        {name}
      </span>
    </span>
  </span>
);

/** The pieces and the cursors at one step. */
export const Scene = ({
  shown,
  hands,
  names,
  still,
  round,
  step,
}: SceneProps) => (
  <>
    {shown.map(({ piece, index, moved, cleared }) => (
      <span
        key={`${round}-${index}`}
        data-slot="app-building-piece"
        data-kind={piece.kind}
        {...stylex.props(
          styles.slot,
          styles.at(piece.x, piece.y, piece.w, piece.h),
          styles.moved(moved.x, moved.y),
          cleared && styles.cleared
        )}
      >
        <span
          {...stylex.props(styles.surface, blocks.piece, still && styles.still)}
        />
        <span
          {...stylex.props(
            styles.piece,
            kindStyles[piece.kind],
            still && styles.still
          )}
        >
          <Parts kind={piece.kind} still={still} />
        </span>
      </span>
    ))}
    {hands.map((hand, index) => (
      <Cursor
        key={index}
        hand={hand}
        name={names[index] ?? ""}
        tone={index}
        ring={`${round}-${step}`}
      />
    ))}
  </>
);
