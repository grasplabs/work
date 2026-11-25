import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { chooseLocale, isLocale, localeNames } from "../i18n.ts";
import type { Locale } from "../i18n.ts";
import { FlagMark } from "./flag-mark.tsx";
import { useNarrow } from "./use-narrow.ts";

// The language, in the setup's bar and the interview's header alike: the
// library's Select in its quiet form (ghost, small), each language with its
// flag before its name in its own words; closed, the chosen one's flag and
// name, on a phone its flag and short code ("EN").

const styles = stylex.create({
  // A flag and its name, on one line.
  named: { display: "inline-flex", alignItems: "center", gap: space["2"] },
});

const languages = Object.entries(localeNames).flatMap(([code, name]) =>
  isLocale(code) ? [{ code, name }] : []
);

export const LanguagePicker = () => {
  const { t, i18n } = useLingui();
  const narrow = useNarrow();
  const locale: Locale = isLocale(i18n.locale) ? i18n.locale : "en";
  const language = localeNames[locale];
  return (
    <Select
      items={languages.map(({ code, name }) => ({
        value: code,
        label: narrow ? code.toUpperCase() : name,
      }))}
      onValueChange={(value) => {
        if (isLocale(value)) {
          void chooseLocale(value);
        }
      }}
      value={locale}
    >
      <SelectTrigger
        aria-label={t`Language: ${language}`}
        size="sm"
        // Named on a pause, as the bar's other tools are.
        tooltip={t`Language`}
        variant="ghost"
      >
        <span {...stylex.props(styles.named)}>
          <FlagMark locale={locale} />
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent>
        {languages.map(({ code, name }) => (
          <SelectItem key={code} label={name} value={code}>
            <span lang={code} {...stylex.props(styles.named)}>
              <FlagMark locale={code} />
              {name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
