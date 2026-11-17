// ComposerEffort: how hard the agent thinks, in the surface the footer's model-and-effort control
// opens (model-effort.tsx). Grasp's Level slider at its compact size: a round track of dots lit up to
// the thumb, the scale's two ends named under it, the level said to a screen reader in words
// ("Max"), never as a second value beside the heading. The strongest level (an option's `top`, the
// last) is a state of its own: the working light in the dots, the thumb aglow.
"use client";

import { LevelSlider } from "../level-slider";
import type { ComposerReasoningOption } from "./reasoning";

/** Every prop a ComposerEffort takes. */
export interface ComposerEffortProps {
  /** The levels, from the least effort to the most. */
  levels: ComposerReasoningOption[];
  /** The chosen level's `value`. */
  value: string;
  /** Called with the level chosen. */
  onValueChange: (value: string) => void;
  /** Its heading, and the slider's name ("Effort"). */
  label: string;
}

/** Effort as Grasp's Level slider, compact. */
export const ComposerEffort = ({
  levels,
  value,
  onValueChange,
  label,
}: ComposerEffortProps) => (
  <div data-slot="composer-effort">
    <LevelSlider
      label={label}
      size="compact"
      levels={levels.map((level) => ({ id: level.value, label: level.label }))}
      value={value}
      onValueChange={onValueChange}
      top={levels.at(-1)?.top === true}
    />
  </div>
);
