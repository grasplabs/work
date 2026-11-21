// The Theme switch as a segmented control: Light, Dark, System, each with its icon. Native radios,
// so the browser gives the keys: arrows move and choose, in the reading direction. The pill moves
// to the chosen one by a whole segment.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ChangeEvent } from "react";

import { focus } from "../focus/focus";
import { Computer, Icon, Moon, Sun } from "../icons";
import type { IconData } from "../icons";
import { themeModes } from "../theme";
import type { ThemeMode } from "../theme";
import { centreOf, toEnds } from "./keys";
import { switchStyles as styles } from "./styles";
import type { ModeWords } from "./words";

const icons: Record<ThemeMode, IconData> = {
  light: Sun,
  dark: Moon,
  system: Computer,
};
const pills = [styles.pill0, styles.pill1, styles.pill2] as const;

export interface ThemeSwitchSegmentedProps {
  mode: ThemeMode | undefined;
  label: string;
  words: (mode: ThemeMode) => ModeWords;
  onChoose: (mode: ThemeMode, origin?: { x: number; y: number }) => void;
}

export const ThemeSwitchSegmented = ({
  mode,
  label,
  words,
  onChoose,
}: ThemeSwitchSegmentedProps) => {
  const name = useId();
  const chosen = mode === undefined ? -1 : themeModes.indexOf(mode);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      {...stylex.props(styles.segments)}
    >
      {chosen >= 0 && (
        <span
          aria-hidden="true"
          {...stylex.props(styles.pill, pills[chosen])}
        />
      )}
      {themeModes.map((each) => (
        <label
          key={each}
          {...stylex.props(
            styles.segment,
            each === mode && styles.segmentOn,
            focus.within
          )}
        >
          <input
            type="radio"
            name={name}
            value={each}
            checked={each === mode}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              onChoose(each, centreOf(event.currentTarget));
            }}
            onKeyDown={toEnds}
            {...stylex.props(styles.native)}
          />
          <Icon icon={icons[each]} />
          {words(each).name}
        </label>
      ))}
    </div>
  );
};
