// The drawing on App building's stage: the pieces standing at this step and the cursors over them.
// It draws what plan.ts says; it holds no state of its own.
import * as stylex from "@stylexjs/stylex";

import { Icon, Pointer } from "../icons";
import { kindStyles, Parts } from "./parts";
import type { AppBuildingLook } from "./parts";
import type { Hand, Shown } from "./plan";
import { fills, looks, styles, tones } from "./styles";

interface SceneProps {
  look: AppBuildingLook;
  shown: readonly Shown[];
  hands: readonly Hand[];
  names: readonly string[];
  /** Reduced motion: nothing moves in. */
  still: boolean;
  /** The round, so a new round's pieces come in afresh. */
  round: number;
  /** The step, so each press draws its ring afresh. */
  step: number;
  /** The build is over: the cursors leave. */
  done: boolean;
}

// Where a cursor goes as the build ends: a little on, as it fades.
const LEAVE = { x: 4, y: 8 };

const Cursor = ({
  hand,
  name,
  tone,
  done,
  ring,
}: {
  hand: Hand;
  name: string;
  tone: number;
  done: boolean;
  ring: string;
}) => {
  const x = done ? hand.x + LEAVE.x : hand.x;
  const y = done ? hand.y + LEAVE.y : hand.y;
  return (
    <span
      data-slot="app-building-cursor"
      {...stylex.props(styles.track, styles.to(x, y), done && styles.gone)}
    >
      <span {...stylex.props(styles.cursor, tones[tone % tones.length])}>
        {/* Pointer points along the line (src/icons `pointing`): the icon turns round itself right
            to left, marked so (data-mirror), and its tip still leads its name. */}
        <Icon icon={Pointer} />
        {hand.pressing && !done ? (
          <span key={ring} {...stylex.props(styles.ring)} />
        ) : null}
        <span {...stylex.props(styles.tag, fills[tone % fills.length])}>
          {name}
        </span>
      </span>
    </span>
  );
};

/** The pieces and the cursors at one step. */
export const Scene = ({
  look,
  shown,
  hands,
  names,
  still,
  round,
  step,
  done,
}: SceneProps) => {
  const tone = looks[look];
  return (
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
            {...stylex.props(styles.surface, tone.piece, still && styles.still)}
          />
          <span
            {...stylex.props(
              styles.piece,
              kindStyles[piece.kind],
              still && styles.still
            )}
          >
            <Parts kind={piece.kind} look={look} still={still} />
          </span>
        </span>
      ))}
      {hands.map((hand, index) => (
        <Cursor
          key={index}
          hand={hand}
          name={names[index] ?? ""}
          tone={index}
          done={done}
          ring={`${round}-${step}`}
        />
      ))}
    </>
  );
};
