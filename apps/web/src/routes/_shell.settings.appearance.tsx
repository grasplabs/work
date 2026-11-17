import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { SectionCard } from "../grasp/section-card/index.ts";
import { ThemeSwitch } from "../grasp/theme-switch/index.ts";
import { BackdropSettings } from "../settings/backdrop-settings.tsx";
import { ComposerSettings } from "../settings/composer-settings.tsx";
import { SettingsError } from "../settings/section.tsx";

// Settings → Appearance: how Grasp looks for this person. Light, dark or
// the device's, and the colours (Grasp UI's themes), with Grasp UI's Theme
// switch: each choice a tile drawn in what it is, kept as it is pressed
// (frame/person-theme.tsx keeps it, as the Sidebar's Appearance does).
// Then what stands behind Chat's own page (settings/backdrop-settings.tsx),
// and how the chat's box draws Grasp at work (settings/composer-settings.tsx).

/** The mode and the colours, as tiles. */
const Theme = () => {
  const { t } = useLingui();
  return (
    <SectionCard title={t`Theme`}>
      <ThemeSwitch
        variant="picker"
        label={t`Mode`}
        iconLabel={(named, current, next) =>
          t`${named}, ${current}. Switch to ${next}`
        }
        // No line under a tile: each is drawn as what it is, and its name
        // says the rest (Ruben, 17 Nov: no subtitles unless needed).
        modeWords={{
          light: { name: t`Light`, line: "" },
          dark: { name: t`Dark`, line: "" },
          system: { name: t`System`, line: "" },
        }}
        // The themes' names are their own, as a product's are.
        themeWords={{
          evergreen: { name: "Evergreen", line: "" },
          pine: { name: "Pine", line: "" },
          paper: { name: "Paper", line: "" },
        }}
        themesLabel={t`Colours`}
      />
    </SectionCard>
  );
};

const Appearance = () => {
  const { identity } = Route.useRouteContext();
  return (
    <>
      <Theme />
      <BackdropSettings userId={identity.userId} />
      <ComposerSettings userId={identity.userId} />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/appearance")({
  errorComponent: SettingsError,
  component: Appearance,
});
