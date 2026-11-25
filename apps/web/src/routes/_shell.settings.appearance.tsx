import { ThemeToggle } from "@grasp-os/ui/components/theme-toggle";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

import {
  chooseTheme,
  chooseThemeId,
  onThemeChange,
  readTheme,
  readThemeId,
} from "../frame/theme.ts";
import { ComposerSettings } from "../settings/composer-settings.tsx";
import { SettingsError, SettingsGroup } from "../settings/section.tsx";

// Settings → Appearance: how Grasp looks for this person. Light, dark or
// the device's, and the colours (Damsko's themes), with Damsko's Theme
// toggle as tiles: each choice drawn in what it is, kept as it is pressed
// (frame/theme.ts keeps it, as the person menu's Appearance does); then
// how the chat box draws Grasp at work.

/** The mode and the colours, as tiles. */
const Theme = ({ userId }: { userId: string }) => {
  const { t } = useLingui();
  // Read where it is kept, so a choice made in another tab shows here too.
  const mode = useSyncExternalStore(onThemeChange, () => readTheme(userId));
  const theme = useSyncExternalStore(onThemeChange, () => readThemeId(userId));
  return (
    <SettingsGroup title={t`Theme`}>
      <ThemeToggle
        heading={t`Mode`}
        mode={mode}
        onModeChange={(next) => {
          chooseTheme(userId, next);
        }}
        onThemeChange={(next) => {
          chooseThemeId(userId, next);
        }}
        theme={theme}
        // The themes' names are their own, as a product's are; no line
        // under a tile: each is drawn as what it is.
        themes={[
          { id: "evergreen", name: "Evergreen", line: "" },
          { id: "pine", name: "Pine", line: "" },
          { id: "paper", name: "Paper", line: "" },
        ]}
        variant="picker"
      />
    </SettingsGroup>
  );
};

const Appearance = () => {
  const { identity } = Route.useRouteContext();
  return (
    <>
      <Theme userId={identity.userId} />
      <ComposerSettings userId={identity.userId} />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/appearance")({
  errorComponent: SettingsError,
  component: Appearance,
});
