import { Button } from "@grasp-os/ui/components/button";
import { useLingui } from "@lingui/react/macro";

import { chooseLook, useLook } from "../chat/backdrop-look.ts";
import {
  backdropKinds as backdrops,
  ditherPatterns,
  ditherTones,
} from "../chat/backdrop/look.ts";
import type { BackdropLook as Look } from "../chat/backdrop/look.ts";
import { BackdropPreview } from "../chat/backdrop/preview.tsx";
import { LookTiles } from "./look-tiles.tsx";
import type { LookTilesWords } from "./look-tiles.tsx";
import { SettingsGroup, SettingsStack } from "./section.tsx";

// Settings › Appearance: what stands behind Chat's start (the person's
// look, chat/backdrop-look.ts), chosen by sight, as the reference's Chat
// background (#2503's settings/backdrop-settings.tsx). The look live and
// large, then every background as a still picture to scroll through and
// click, and for a dither its patterns and colours as pictures too
// (look-tiles.tsx). Randomize picks any look. Each choice is kept as it is
// made.

/** One of `items` by chance, else `fallback` (for no items). */
const anyOf = <T,>(items: readonly T[], fallback: T): T =>
  items[Math.floor(Math.random() * items.length)] ?? fallback;

/** A look by chance, never the one shown now, nor nothing. */
const randomLook = (now: Look): Look => {
  const shown = backdrops.filter(
    (each) => each !== "none" && each !== now.backdrop
  );
  return {
    backdrop: anyOf(shown, now.backdrop),
    pattern: anyOf(ditherPatterns, now.pattern),
    tone: anyOf(ditherTones, now.tone),
  };
};

/** What the tiles are called, in the page's language. */
const useTileWords = (): LookTilesWords => {
  const { t } = useLingui();
  return {
    backdropLabel: t`Background`,
    patternLabel: t`Pattern`,
    toneLabel: t({ message: "Colour", context: "a background's colour" }),
    backdrops: {
      cliffs: t`Cliffs`,
      wave: t`Wave`,
      aurora: t`Aurora`,
      starry: t`Starry night`,
      fuji: t`Fuji`,
      wanderer: t`Wanderer`,
      dusk: t`Dusk`,
      dots: t`Dots`,
      door: t`Door`,
      sand: t`Sand`,
      dunes: t`Dunes`,
      rings: t`Rings`,
      pixels: t`Pixel sand`,
      none: t({ message: "None", context: "no background" }),
    },
    patterns: { bayer: t`Bayer`, grid: t`Grid`, mix: t`Bayer grid` },
    tones: {
      light: t({ message: "Light", context: "a background's colour" }),
      deep: t`Deep`,
      mint: t`Mint`,
      lime: t`Lime`,
      ink: t`Ink`,
      rim: t`Dark edge`,
      core: t`Light edge`,
      aurora: t`Aurora`,
    },
  };
};

/** The person's background for Chat's start, chosen by sight. */
export const BackdropSettings = ({ userId }: { userId: string }) => {
  const { t } = useLingui();
  const look = useLook(userId);
  const words = useTileWords();
  return (
    <SettingsGroup
      actions={
        <Button
          onClick={() => {
            chooseLook(userId, randomLook(look));
          }}
          size="sm"
          variant="outline"
        >
          {t`Randomize`}
        </Button>
      }
      title={t`Chat background`}
    >
      <SettingsStack>
        <BackdropPreview look={look} />
        <LookTiles
          look={look}
          onLook={(chosen) => {
            chooseLook(userId, chosen);
          }}
          words={words}
        />
      </SettingsStack>
    </SettingsGroup>
  );
};
