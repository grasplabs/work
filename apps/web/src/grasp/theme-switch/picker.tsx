// The Theme switch as a picker, for a settings page: a row of mode tiles and a row of theme tiles,
// each a real miniature of the interface in that mode or theme. The System tile shows both halves.
// Native radios, so the browser gives the keys. Hovering or focusing a theme tile shows that theme
// on the page at once; leaving puts the chosen one back; choosing keeps it.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ChangeEvent, ReactNode } from "react";

import { focus } from "../focus/focus";
import { Icon, Tick } from "../icons";
import { themeIds, themeModes } from "../theme";
import type { ThemeId, ThemeMode } from "../theme";
import { centreOf, toEnds } from "./keys";
import { Miniature } from "./miniature";
import { switchStyles as styles } from "./styles";
import type { ModeWords, ThemeWords } from "./words";

interface TileProps {
  group: string;
  value: string;
  chosen: boolean;
  theme: ThemeId;
  mode: ThemeMode;
  words: ModeWords | ThemeWords;
  onChoose: (origin: { x: number; y: number }) => void;
  onPreview?: (on: boolean) => void;
  children?: ReactNode;
}

const Tile = ({
  group,
  value,
  chosen,
  theme,
  mode,
  words,
  onChoose,
  onPreview,
  children,
}: TileProps) => (
  <label
    onPointerEnter={() => {
      onPreview?.(true);
    }}
    onPointerLeave={() => {
      onPreview?.(false);
    }}
    {...stylex.props(styles.tile, focus.within)}
  >
    <input
      type="radio"
      name={group}
      value={value}
      checked={chosen}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        onChoose(centreOf(event.currentTarget));
      }}
      onKeyDown={toEnds}
      onFocus={() => {
        onPreview?.(true);
      }}
      onBlur={() => {
        onPreview?.(false);
      }}
      {...stylex.props(styles.native)}
    />
    <span aria-hidden="true" {...stylex.props(styles.frame)}>
      <span
        data-grasp-theme={theme}
        data-grasp-mode={mode}
        {...stylex.props(
          styles.mini,
          children !== undefined && styles.miniSystem,
          chosen && styles.miniOn
        )}
      >
        {children ?? <Miniature />}
      </span>
      {chosen && (
        <span data-slot="theme-switch-ring" {...stylex.props(styles.ring)} />
      )}
      {chosen && (
        <span {...stylex.props(styles.tick)}>
          <Icon icon={Tick} />
        </span>
      )}
    </span>
    <span {...stylex.props(styles.name)}>{words.name}</span>
    {words.line !== "" && (
      <span {...stylex.props(styles.line)}>{words.line}</span>
    )}
  </label>
);

export interface ThemeSwitchPickerProps {
  mode: ThemeMode | undefined;
  theme: ThemeId | undefined;
  modeLabel: string;
  themeLabel: string;
  showThemes: boolean;
  tileSize: "fill" | "md";
  modeWords: (mode: ThemeMode) => ModeWords;
  themeWords: (theme: ThemeId) => ThemeWords;
  onChooseMode: (mode: ThemeMode, origin?: { x: number; y: number }) => void;
  onChooseTheme: (theme: ThemeId, origin?: { x: number; y: number }) => void;
  onPreview: (theme?: ThemeId) => void;
}

export const ThemeSwitchPicker = ({
  mode,
  theme,
  modeLabel,
  themeLabel,
  showThemes,
  tileSize,
  modeWords,
  themeWords,
  onChooseMode,
  onChooseTheme,
  onPreview,
}: ThemeSwitchPickerProps) => {
  const modesName = useId();
  const themesName = useId();
  const drawn = theme ?? "evergreen";
  return (
    <>
      <div {...stylex.props(styles.group)}>
        <p {...stylex.props(styles.groupLabel)}>{modeLabel}</p>
        <div
          role="radiogroup"
          aria-label={modeLabel}
          {...stylex.props(styles.tiles, tileSize === "md" && styles.tilesMd)}
        >
          {themeModes.map((each) => (
            <Tile
              key={each}
              group={modesName}
              value={each}
              chosen={each === mode}
              theme={drawn}
              mode={each === "dark" ? "dark" : "light"}
              words={modeWords(each)}
              onChoose={(origin) => {
                onChooseMode(each, origin);
              }}
            >
              {each === "system" ? (
                <>
                  <span
                    data-grasp-theme={drawn}
                    data-grasp-mode="light"
                    {...stylex.props(
                      styles.mini,
                      styles.half,
                      styles.halfLight
                    )}
                  >
                    <Miniature />
                  </span>
                  <span
                    data-grasp-theme={drawn}
                    data-grasp-mode="dark"
                    {...stylex.props(styles.mini, styles.half, styles.halfDark)}
                  >
                    <Miniature />
                  </span>
                </>
              ) : undefined}
            </Tile>
          ))}
        </div>
      </div>
      {showThemes && (
        <div {...stylex.props(styles.group)}>
          <p {...stylex.props(styles.groupLabel)}>{themeLabel}</p>
          <div
            role="radiogroup"
            aria-label={themeLabel}
            {...stylex.props(styles.tiles, tileSize === "md" && styles.tilesMd)}
          >
            {themeIds.map((each) => (
              <Tile
                key={each}
                group={themesName}
                value={each}
                chosen={each === theme}
                theme={each}
                mode={mode ?? "system"}
                words={themeWords(each)}
                onChoose={(origin) => {
                  onChooseTheme(each, origin);
                }}
                onPreview={(on) => {
                  onPreview(on ? each : undefined);
                }}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
};
