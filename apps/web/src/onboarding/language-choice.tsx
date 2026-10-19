import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { useLingui } from "@lingui/react/macro";

import { chooseLocale, isLocale, localeNames } from "../i18n.ts";

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
 */
export const LanguageChoice = ({
  picked,
  onPick,
}: {
  picked: boolean;
  onPick: () => void;
}) => {
  const { t, i18n } = useLingui();
  return (
    <div className="flex flex-col items-center gap-3">
      {/* Stephen asks for it at the end of his greeting, so there is no label above it. */}
      <ToggleGroup
        aria-label={t`Choose your language`}
        className="flex-wrap justify-center"
        onValueChange={(value: unknown[]) => {
          const [chosen] = value;
          // Pressing the chosen one again keeps it.
          if (isLocale(chosen)) {
            void chooseLocale(chosen);
            onPick();
          }
        }}
        size="sm"
        spacing={1}
        value={picked ? [i18n.locale] : []}
      >
        {languages.map((language) => (
          <ToggleGroupItem
            key={language.value}
            lang={language.value}
            value={language.value}
          >
            {language.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
};
