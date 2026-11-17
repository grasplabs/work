import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { SectionCard } from "../grasp/section-card/index.ts";
import { ThemeSwitch } from "../grasp/theme-switch/index.ts";
import { BackdropSettings } from "../settings/backdrop-settings.tsx";
import { SettingsError } from "../settings/section.tsx";

// Settings → Appearance: how Grasp looks for this person. Light, dark or
// the device's, and the colours (Grasp UI's themes), with Grasp UI's Theme
// switch: each choice a tile drawn in what it is, kept as it is pressed
// (frame/person-theme.tsx keeps it, as the Sidebar's Appearance does).
// Then what stands behind Chat's own page (settings/backdrop-settings.tsx).

/** The mode and the colours, as tiles. */
const Theme = () => {
  const { t } = useLingui();
  return (
    <SectionCard
      description={t`Yours alone, kept in this browser.`}
      title={t`Theme`}
    >
      <ThemeSwitch
        variant="picker"
        label={t`Mode`}
        modeWords={{
          light: { name: t`Light`, line: t`Always light` },
          dark: { name: t`Dark`, line: t`Always dark` },
          system: { name: t`System`, line: t`As your device` },
        }}
        // The themes' names are their own, as a product's are; their lines are said.
        themeWords={{
          evergreen: { name: "Evergreen", line: t`Grasp as it is` },
          pine: { name: "Pine", line: t`Night in the forest` },
          paper: { name: "Paper", line: t`Warm and quiet` },
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
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/appearance")({
  errorComponent: SettingsError,
  component: Appearance,
});
