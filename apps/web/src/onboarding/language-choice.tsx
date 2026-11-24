import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { useLingui } from "@lingui/react/macro";

import { chooseLocale, isLocale, localeNames } from "../i18n.ts";
import type { Locale } from "../i18n.ts";
import { useNarrow } from "./use-narrow.ts";

// The language is chosen on the first step and kept in the corner after it
// (prototype `components/onboarding/onboarding-language.tsx`).

const languages = Object.entries(localeNames).map(([value, label]) => ({
  value,
  label,
}));

/**
 * Every language, named in its own words, and none chosen yet: the page
 * reads in the browser's language until you pick one, and the way on waits
 * for it. The options themselves stay put, so the keys keep their place.
 * Stephen asks for it at the end of his greeting, so there is no label above it.
 * The five side by side need more than a phone's width, and a ToggleGroup's
 * row can't wrap (its style holds no `flexWrap`): on a phone they stand one
 * under the other.
 */
export const LanguageChoice = ({
  picked,
  onPick,
}: {
  picked: boolean;
  /** Told which, before the page turns to it. */
  onPick: (locale: Locale) => void;
}) => {
  const { t, i18n } = useLingui();
  const narrow = useNarrow();
  return (
    <ToggleGroup
      aria-label={t`Choose your language`}
      onValueChange={(value: unknown[]) => {
        const [chosen] = value;
        // Pressing the chosen one again keeps it.
        if (isLocale(chosen)) {
          onPick(chosen);
          void chooseLocale(chosen);
        }
      }}
      orientation={narrow ? "vertical" : "horizontal"}
      size="xs"
      value={picked ? [i18n.locale] : []}
    >
      {languages.map((language) => (
        <ToggleGroupItem key={language.value} value={language.value}>
          <span lang={language.value}>{language.label}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
};
