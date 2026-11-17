"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";

import { Button } from "../button";
import { Field, FieldDescription, FieldLabel } from "../field";
import { focus } from "../focus/focus";
import { Select, SelectTrigger, SelectValue, SelectContent } from "../select";
import type { SelectItems } from "../select";
import { grasp } from "../tokens/tokens.stylex";
import { defaultScenes } from "./backdrop";
import type { BackdropLayoutStyle } from "./backdrop";
import { BackdropField } from "./field";
import {
  backdropKinds,
  ditherKinds,
  ditherPatterns,
  ditherTones,
  isDither,
  byNewName,
  sandKinds,
  sceneKinds,
} from "./look";
import type {
  BackdropKind,
  BackdropLook,
  BackdropPattern,
  BackdropTone,
} from "./look";
import { BackdropPreview } from "./preview";

/** Every word the picker shows or says, with English defaults. */
export interface BackdropPickerWords {
  /** Each backdrop's name. */
  names: Record<BackdropKind, string>;
  /** Each pattern's name. */
  patterns: Record<BackdropPattern, string>;
  /** Each colour's name. */
  tones: Record<BackdropTone, string>;
  /** The names over the backdrop list's groups. */
  scenes: string;
  dithers: string;
  sand: string;
  /** The three fields: label and description. */
  backdrop: string;
  backdropHint: string;
  pattern: string;
  patternHint: string;
  tone: string;
  toneHint: string;
  /** The preview's question, and its name for who can't see it. */
  previewTitle: string;
  previewLabel: string;
  /** The tiles' button that picks any look. */
  randomize: string;
}

const defaults: BackdropPickerWords = {
  names: {
    cliffs: "Cliffs",
    wave: "Wave",
    aurora: "Aurora",
    starry: "Starry night",
    fuji: "Fuji",
    wanderer: "Wanderer",
    dusk: "Dusk",
    dots: "Dots",
    door: "Door",
    sand: "Sand",
    dunes: "Dunes",
    rings: "Rings",
    pixels: "Pixel sand",
    none: "None",
  },
  patterns: { bayer: "Bayer", grid: "Grid", mix: "Bayer grid" },
  tones: {
    light: "Light",
    deep: "Deep",
    mint: "Mint",
    lime: "Lime",
    ink: "Ink",
    rim: "Dark edge",
    core: "Light edge",
    aurora: "Aurora",
  },
  scenes: "Scenes",
  dithers: "Dithers",
  sand: "Sand",
  backdrop: "Backdrop",
  backdropHint: "A scene, a dither, sand, or nothing.",
  pattern: "Pattern",
  patternHint: "How the dither's cells are set.",
  tone: "Colour",
  toneHint: "One green, or a run of greens from the edge in.",
  previewTitle: "What should we look at today?",
  previewLabel: "Preview of your chat backdrop",
  randomize: "Randomize",
};

/** Every prop a BackdropPicker takes. */
export interface BackdropPickerProps {
  /** The look chosen now. */
  value: BackdropLook;
  /** Called with the new look as each choice is made. */
  onValueChange?: (look: BackdropLook) => void;
  /** @deprecated Use `onValueChange`. */
  onChange?: (look: BackdropLook) => void;
  /**
   * `fields`: a live preview over three fields. `tiles`: every backdrop as a small live tile to
   * press, a dither's pattern and colour as a row of choices under them, and Randomize.
   * @default "fields"
   */
  variant?: "fields" | "tiles";
  /** Its words, in the person's language. Any left out are English. */
  words?: Partial<BackdropPickerWords>;
  /**
   * Where the scene pictures are served from, as Backdrop's `scenes`.
   * @default "/backdrops/"
   */
  scenes?: string;
  /** @deprecated Use `layout`. */
  style?: BackdropLayoutStyle;
  /** Layout only: where it sits and how wide it is. */
  layout?: BackdropLayoutStyle;
}

const styles = stylex.create({
  picker: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space6,
    width: "100%",
  },
  // ---- The tiles: each backdrop small and live, a radio over it, at most picker-tile wide ----
  group: {
    display: "grid",
    gap: grasp.space2,
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
  },
  legend: {
    padding: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  tiles: {
    display: "grid",
    gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, 6rem), ${grasp.pickerTile}))`,
    gap: grasp.space3,
    justifyContent: "start",
    minWidth: 0,
  },
  tile: {
    position: "relative",
    display: "grid",
    alignContent: "start",
    gap: grasp.space1,
    minWidth: 0,
    borderRadius: grasp.corner,
    fontFamily: grasp.fontSans,
    color: grasp.ink,
    cursor: "pointer",
  },
  // The radio covers the tile, and only it: the browser gives the keys.
  native: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    margin: 0,
    opacity: 0,
    cursor: "pointer",
  },
  window: {
    position: "relative",
    isolation: "isolate",
    aspectRatio: "16 / 10",
    overflow: "hidden",
    pointerEvents: "none",
    borderRadius: grasp.corner,
    backgroundColor: grasp.paper,
    boxShadow: `inset 0 0 0 ${grasp.hairline} ${grasp.line}`,
  },
  // The chosen tile: 2px of the page's ink round its window, 2px of the page's ground between, so
  // the ring reads on a dark scene as on a light one.
  chosen: { boxShadow: `0 0 0 2px ${grasp.paper}, 0 0 0 4px ${grasp.ink}` },
  name: {
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.text,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // A dither's pattern and colour: a row of words to press.
  chips: { display: "flex", flexWrap: "wrap", gap: grasp.space2 },
  chip: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    minHeight: grasp.controlSm,
    paddingInline: grasp.space3,
    borderRadius: grasp.corner,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    color: grasp.text,
    boxShadow: `inset 0 0 0 ${grasp.hairline} ${grasp.line}`,
    cursor: "pointer",
  },
  chipOn: { color: grasp.ink, boxShadow: `inset 0 0 0 2px ${grasp.ink}` },
  randomize: { alignSelf: "start" },
});

/** Any value of `list`, at random. */
const anyOf = <T,>(list: readonly T[]): T | undefined =>
  list[Math.floor(Math.random() * list.length)];

interface ChoiceProps {
  group: string;
  value: string;
  chosen: boolean;
  onChoose: () => void;
  /** The pointer or the keyboard comes to it (true) or leaves it (false). */
  onNear?: (near: boolean) => void;
}

/** A radio over what is drawn inside it: a tile's window and name, or a chip's word. */
const Choice = ({ group, value, chosen, onChoose, onNear }: ChoiceProps) => (
  <input
    type="radio"
    name={group}
    value={value}
    checked={chosen}
    onChange={() => {
      onChoose();
    }}
    onPointerEnter={() => {
      onNear?.(true);
    }}
    onPointerLeave={() => {
      onNear?.(false);
    }}
    onFocus={() => {
      onNear?.(true);
    }}
    onBlur={() => {
      onNear?.(false);
    }}
    {...stylex.props(styles.native)}
  />
);

interface TilesProps {
  value: BackdropLook;
  onChange: (look: BackdropLook) => void;
  said: BackdropPickerWords;
  scenes: string;
}

/** Every backdrop as a small live tile, a dither's pattern and colour under them, and Randomize. */
const Tiles = ({ value, onChange, said, scenes }: TilesProps) => {
  const kindsName = useId();
  // The tile under the pointer or the keyboard draws live with the chosen one; the rest rest still.
  const [near, setNear] = useState<BackdropKind | null>(null);
  const patternsName = useId();
  const tonesName = useId();
  const randomize = () => {
    const backdrop =
      anyOf(
        backdropKinds.filter(
          (kind) => kind !== "none" && kind !== value.backdrop
        )
      ) ?? value.backdrop;
    onChange({
      backdrop,
      pattern: anyOf(ditherPatterns) ?? value.pattern,
      tone: anyOf(ditherTones) ?? value.tone,
    });
  };
  return (
    <>
      <fieldset {...stylex.props(styles.group)}>
        <legend {...stylex.props(styles.legend)}>{said.backdrop}</legend>
        <div {...stylex.props(styles.tiles)}>
          {backdropKinds.map((kind) => (
            <label
              key={kind}
              data-slot="backdrop-tile"
              {...stylex.props(styles.tile, focus.within)}
            >
              <Choice
                group={kindsName}
                value={kind}
                chosen={value.backdrop === kind}
                onChoose={() => {
                  onChange({ ...value, backdrop: kind });
                }}
                onNear={(coming) => {
                  setNear(coming ? kind : null);
                }}
              />
              <span
                aria-hidden="true"
                {...stylex.props(
                  styles.window,
                  value.backdrop === kind && styles.chosen
                )}
              >
                {kind === "none" ? null : (
                  <BackdropField
                    look={{ ...value, backdrop: kind }}
                    clear={undefined}
                    scenes={scenes}
                    small
                    still={kind !== value.backdrop && kind !== near}
                  />
                )}
              </span>
              <span {...stylex.props(styles.name)}>{said.names[kind]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {isDither(value.backdrop) ? (
        <>
          <fieldset {...stylex.props(styles.group)}>
            <legend {...stylex.props(styles.legend)}>{said.pattern}</legend>
            <div {...stylex.props(styles.chips)}>
              {ditherPatterns.map((pattern) => (
                <label
                  key={pattern}
                  {...stylex.props(
                    styles.chip,
                    value.pattern === pattern && styles.chipOn,
                    focus.within
                  )}
                >
                  <Choice
                    group={patternsName}
                    value={pattern}
                    chosen={value.pattern === pattern}
                    onChoose={() => {
                      onChange({ ...value, pattern });
                    }}
                  />
                  {said.patterns[pattern]}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset {...stylex.props(styles.group)}>
            <legend {...stylex.props(styles.legend)}>{said.tone}</legend>
            <div {...stylex.props(styles.chips)}>
              {ditherTones.map((tone) => (
                <label
                  key={tone}
                  {...stylex.props(
                    styles.chip,
                    value.tone === tone && styles.chipOn,
                    focus.within
                  )}
                >
                  <Choice
                    group={tonesName}
                    value={tone}
                    chosen={value.tone === tone}
                    onChoose={() => {
                      onChange({ ...value, tone });
                    }}
                  />
                  {said.tones[tone]}
                </label>
              ))}
            </div>
          </fieldset>
        </>
      ) : null}
      <Button size="sm" onClick={randomize} layout={styles.randomize}>
        {said.randomize}
      </Button>
    </>
  );
};

/** One of `list`, if `value` is in it. */
const oneOf = <T extends string>(
  list: readonly T[],
  value: string | null
): T | undefined => list.find((each) => each === value);

/** A look, chosen live: a preview, the backdrop, and for a dither its pattern and colour. */
export const BackdropPicker = ({
  value,
  onChange: onChangeDeprecated,
  onValueChange,
  variant = "fields",
  words,
  scenes = defaultScenes,
  style: styleProp,
  layout,
}: BackdropPickerProps) => {
  const onChange = byNewName(
    onValueChange,
    onChangeDeprecated,
    "BackdropPicker: pass `onValueChange`."
  );
  const said: BackdropPickerWords = { ...defaults, ...words };
  const kinds: SelectItems = [
    {
      type: "group",
      label: said.scenes,
      items: sceneKinds.map((kind) => ({
        value: kind,
        label: said.names[kind],
      })),
    },
    {
      type: "group",
      label: said.dithers,
      items: ditherKinds.map((kind) => ({
        value: kind,
        label: said.names[kind],
      })),
    },
    {
      type: "group",
      label: said.sand,
      items: sandKinds.map((kind) => ({
        value: kind,
        label: said.names[kind],
      })),
    },
    { value: "none", label: said.names.none },
  ];
  const patterns: SelectItems = ditherPatterns.map((pattern) => ({
    value: pattern,
    label: said.patterns[pattern],
  }));
  const tones: SelectItems = ditherTones.map((tone) => ({
    value: tone,
    label: said.tones[tone],
  }));
  if (variant === "tiles") {
    return (
      <div
        data-slot="backdrop-picker"
        data-variant="tiles"
        {...stylex.props(styles.picker, layout ?? styleProp)}
      >
        <Tiles value={value} onChange={onChange} said={said} scenes={scenes} />
      </div>
    );
  }
  return (
    <div
      data-slot="backdrop-picker"
      {...stylex.props(styles.picker, layout ?? styleProp)}
    >
      <BackdropPreview
        aria-label={said.previewLabel}
        variant={value}
        scenes={scenes}
        title={said.previewTitle}
      />
      <Field name="backdrop">
        <FieldLabel>{said.backdrop}</FieldLabel>
        <Select
          items={kinds}
          onValueChange={(chosen) => {
            const backdrop = oneOf(backdropKinds, chosen);
            if (backdrop !== undefined) {
              onChange({ ...value, backdrop });
            }
          }}
          value={value.backdrop}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent />
        </Select>
        <FieldDescription>{said.backdropHint}</FieldDescription>
      </Field>
      {isDither(value.backdrop) ? (
        <>
          <Field name="backdrop-pattern">
            <FieldLabel>{said.pattern}</FieldLabel>
            <Select
              items={patterns}
              onValueChange={(chosen) => {
                const pattern = oneOf(ditherPatterns, chosen);
                if (pattern !== undefined) {
                  onChange({ ...value, pattern });
                }
              }}
              value={value.pattern}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent />
            </Select>
            <FieldDescription>{said.patternHint}</FieldDescription>
          </Field>
          <Field name="backdrop-tone">
            <FieldLabel>{said.tone}</FieldLabel>
            <Select
              items={tones}
              onValueChange={(chosen) => {
                const tone = oneOf(ditherTones, chosen);
                if (tone !== undefined) {
                  onChange({ ...value, tone });
                }
              }}
              value={value.tone}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent />
            </Select>
            <FieldDescription>{said.toneHint}</FieldDescription>
          </Field>
        </>
      ) : null}
    </div>
  );
};
