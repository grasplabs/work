import {
  Item,
  ItemContent,
  ItemGrid,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { CheckIcon, Icon } from "@grasp-os/ui/lib/icons";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { AppCardGround } from "../../apps/app-card/ground.tsx";
import type { AppCardGroundHue } from "../../apps/app-card/ground.tsx";
import type { Scene } from "../../apps/app-card/scenes.ts";
import { isLocale, localeNames } from "../../i18n.ts";
import type { Locale } from "../../i18n.ts";
import { FlagPicture } from "./flag-picture.tsx";

// The language, chosen from five cards, one a language, each named in its
// own words, one line: Damsko's Items as choices, each one button, in Tab
// order, Enter or Space to choose. Coming back to the step, the language in
// use takes Item's selected fill (said as the current one) and a tick;
// never on a first visit. Each card carries a picture as its ItemMedia,
// drawn with the product's own dither, in one of three looks:
// - `flag`: its flag in its own colours over the whole card, waving once,
//   fading out by the dither toward the name;
// - `brand`: the same flag in the brand's stops, night to paper;
// - `scene`: one of the App cards' dithered scenes, a small crisp flag in
//   its corner.
// The picture is decoration: the language's own name is the card's name.

/** How a card is drawn. */
export type CardLook = "flag" | "brand" | "scene";

export const isCardLook = (value: unknown): value is CardLook =>
  value === "flag" || value === "brand" || value === "scene";

const styles = stylex.create({
  // Tall enough for the flag to read; the flag lies over the whole card.
  card: { position: "relative", minHeight: "4rem" },
  // The scene's room: the ground fills the positioned box it stands in.
  scene: {
    position: "relative",
    isolation: "isolate",
    overflow: "hidden",
    display: "block",
    width: { default: "6rem", [media.maxSm]: "5rem" },
    height: { default: "4rem", [media.maxSm]: "3.25rem" },
  },
  corner: {
    position: "absolute",
    insetInlineStart: space[1],
    insetBlockEnd: space[1],
  },
});

/**
 * A scene a language, each different; a few nod to their country: Dover's
 * cliffs, Friedrich's wanderer, the Dutch sea, the starry night painted in
 * Provence.
 */
const scenes: Record<
  Locale,
  { scene: Scene; hue: AppCardGroundHue | undefined }
> = {
  en: { scene: "cliffs", hue: undefined },
  de: { scene: "wanderer", hue: "olive" },
  nl: { scene: "wave", hue: "teal" },
  es: { scene: "aurora", hue: "coral" },
  fr: { scene: "starry", hue: "rose" },
};

const languages = Object.entries(localeNames).flatMap(([code, name]) =>
  isLocale(code) ? [{ code, name }] : []
);

/** The card's picture, by its look. */
const Picture = ({ code, look }: { code: Locale; look: CardLook }) => {
  if (look === "scene") {
    const { scene, hue } = scenes[code];
    // The scene, with the small crisp flag in its corner.
    return (
      <span {...stylex.props(styles.scene)}>
        <AppCardGround hue={hue} scene={scene} />
        <span {...stylex.props(styles.corner)}>
          <FlagPicture fit="small" locale={code} tone="real" />
        </span>
      </span>
    );
  }
  return (
    <FlagPicture locale={code} tone={look === "flag" ? "real" : "brand"} />
  );
};

export const LanguageCards = ({
  chosen,
  onPick,
  look = "flag",
}: {
  /** The language in use, when they come back to the step; never on a first visit. */
  chosen: Locale | null;
  onPick: (locale: Locale) => void;
  look?: CardLook;
}) => {
  const { t } = useLingui();
  return (
    <ItemGrid aria-label={t`Your language`}>
      {languages.map(({ code, name }) => (
        <Item
          active={chosen === code}
          key={code}
          onClick={() => {
            onPick(code);
          }}
          style={styles.card}
          variant="outline"
        >
          {look === "scene" ? (
            <ItemMedia>
              <Picture code={code} look={look} />
            </ItemMedia>
          ) : (
            // The flag over the whole card, fading out toward the name.
            <FlagPicture
              fit="cover"
              locale={code}
              tone={look === "flag" ? "real" : "brand"}
            />
          )}
          {/* Coming back: the tick beside the name, clear of the flag at the far edge. */}
          {chosen === code ? (
            <ItemMedia variant="icon">
              <Icon icon={CheckIcon} label={t`Chosen`} />
            </ItemMedia>
          ) : null}
          <ItemContent>
            <ItemTitle>
              <span lang={code}>{name}</span>
            </ItemTitle>
          </ItemContent>
        </Item>
      ))}
    </ItemGrid>
  );
};
