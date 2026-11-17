// The Theme switch as one icon button: it cycles Light, Dark, System. The three icons stand in one
// cell and swap by fading through a small blur, as the Button's own states do; its name says where
// it is and where a press takes it.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { MouseEvent } from "react";

import { focus } from "../focus/focus";
import { Computer, Icon, Moon, Sun } from "../icons";
import type { IconData } from "../icons";
import { themeModes } from "../theme";
import type { ThemeMode } from "../theme";
import { centreOf } from "./keys";
import { switchStyles as styles } from "./styles";

const icons: Record<ThemeMode, IconData> = {
  light: Sun,
  dark: Moon,
  system: Computer,
};

export interface ThemeSwitchIconProps {
  mode: ThemeMode;
  size: "sm" | "md";
  /** The button's name, from where it is and where a press takes it. */
  name: (current: ThemeMode, next: ThemeMode) => string;
  onChoose: (mode: ThemeMode, origin: { x: number; y: number }) => void;
}

export const ThemeSwitchIcon = ({
  mode,
  size,
  name,
  onChoose,
}: ThemeSwitchIconProps) => {
  const index = themeModes.indexOf(mode);
  const next = themeModes[(index + 1) % themeModes.length] ?? "light";
  const press = (event: MouseEvent<HTMLButtonElement>) => {
    onChoose(next, centreOf(event.currentTarget));
  };
  return (
    <button
      type="button"
      aria-label={name(mode, next)}
      onClick={press}
      {...stylex.props(
        styles.icon,
        size === "sm" ? styles.iconSm : styles.iconMd,
        focus.ring
      )}
    >
      <span aria-hidden="true" {...stylex.props(styles.target)} />
      {themeModes.map((each) => (
        <span
          key={each}
          aria-hidden="true"
          {...stylex.props(
            styles.swap,
            each === mode ? styles.swapIn : styles.swapOut
          )}
        >
          <Icon icon={icons[each]} />
        </span>
      ))}
    </button>
  );
};
