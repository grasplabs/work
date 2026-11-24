import {
  Item,
  ItemContent,
  ItemGrid,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Text } from "@grasp-os/ui/components/text";
import { CheckIcon, Icon } from "@grasp-os/ui/lib/icons";
import { focusRing } from "@grasp-os/ui/lib/styles";
import {
  colors,
  media,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
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

/** Under a pointer that can hover, as Damsko's own parts write it. */
const HOVER = "@media (hover: hover)";

const styles = stylex.create({
  // The flag card: one button, its own corner clipping the flag under its name.
  flagCard: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    width: "100%",
    minHeight: "4rem",
    margin: 0,
    paddingInline: space[4],
    borderWidth: 0,
    borderRadius: radius.lg,
    cornerShape: radius.shape,
    overflow: "hidden",
    cursor: "pointer",
    textAlign: "start",
    backgroundColor: {
      default: colors.card,
      ":hover": { default: null, [HOVER]: colors.controlHover },
      ":active": colors.controlActive,
    },
    boxShadow: size.borderStrong,
  },
  // Coming back: the language in use takes the selected fill, as Item's active does.
  current: { backgroundColor: colors.accentActive },
  // The name stands over the flag.
  name: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space[2],
  },
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

/** A scene card's picture: the scene, with the small crisp flag in its corner. */
const Picture = ({ code }: { code: Locale }) => {
  const { scene, hue } = scenes[code];
  return (
    <span {...stylex.props(styles.scene)}>
      <AppCardGround hue={hue} scene={scene} />
      <span {...stylex.props(styles.corner)}>
        <FlagPicture fit="small" locale={code} tone="real" />
      </span>
    </span>
  );
};

interface CardProps {
  code: Locale;
  name: string;
  /** The language in use, when they come back to the step. */
  chosen: boolean;
  onPick: (locale: Locale) => void;
}

/**
 * A language as one button: its flag over the whole card, dense at the far
 * edge and thinning out by the dither toward the name, which stands over
 * it. A component of the setup's own, not an Item: the card's corner clips
 * its picture, which an Item can't hold without a layer inside it.
 */
const FlagCard = ({
  code,
  name,
  chosen,
  onPick,
  tone,
}: CardProps & { tone: "real" | "brand" }) => {
  const { t } = useLingui();
  return (
    <li>
      <button
        {...(chosen && { "aria-current": true })}
        onClick={() => {
          onPick(code);
        }}
        type="button"
        // No tapTarget: that is the hit area inside a small control; the card is 64px tall already.
        {...stylex.props(styles.flagCard, chosen && styles.current, focusRing)}
      >
        <FlagPicture fit="cover" locale={code} tone={tone} />
        <span {...stylex.props(styles.name)}>
          {chosen ? <Icon icon={CheckIcon} label={t`Chosen`} /> : null}
          <Text as="span" color="default" size="sm" weight="medium">
            <span lang={code}>{name}</span>
          </Text>
        </span>
      </button>
    </li>
  );
};

/** A language as an Item: a dithered scene as its media, a small flag in its corner. */
const SceneCard = ({ code, name, chosen, onPick }: CardProps) => {
  const { t } = useLingui();
  return (
    <Item
      active={chosen}
      onClick={() => {
        onPick(code);
      }}
      variant="outline"
    >
      <ItemMedia>
        <Picture code={code} />
      </ItemMedia>
      {chosen ? (
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
      {languages.map(({ code, name }) =>
        look === "scene" ? (
          <SceneCard
            chosen={chosen === code}
            code={code}
            key={code}
            name={name}
            onPick={onPick}
          />
        ) : (
          <FlagCard
            chosen={chosen === code}
            code={code}
            key={code}
            name={name}
            onPick={onPick}
            tone={look === "flag" ? "real" : "brand"}
          />
        )
      )}
    </ItemGrid>
  );
};
