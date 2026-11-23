import { ThemeToggle } from "@grasp-os/ui/components/theme-toggle";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

import { chooseTheme, onThemeChange, readTheme } from "../frame/theme.ts";
import { SettingsError, SettingsGroup } from "../settings/section.tsx";

// Settings › Appearance: how Grasp looks for this person. Light, dark or
// the device's, with Damsko's Theme toggle as tiles that are miniatures of
// the interface, kept as each is pressed: the person's own choice in this
// browser (frame/theme.ts), the same one the person menu changes, so both
// follow either.

/** Light, dark or the system's, as tiles. */
const Theme = ({ userId }: { userId: string }) => {
  const { t } = useLingui();
  const mode = useSyncExternalStore(onThemeChange, () => readTheme(userId));
  return (
    <SettingsGroup flush={false} title={t`Theme`}>
      <ThemeToggle
        heading={t`Mode`}
        mode={mode}
        onModeChange={(chosen) => {
          chooseTheme(userId, chosen);
        }}
        tileSize="default"
        variant="picker"
      />
    </SettingsGroup>
  );
};

const Appearance = () => {
  const { identity } = Route.useRouteContext();
  return <Theme userId={identity.userId} />;
};

export const Route = createFileRoute("/_shell/settings/appearance")({
  errorComponent: SettingsError,
  component: Appearance,
});
