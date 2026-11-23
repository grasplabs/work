import { Container } from "@grasp-os/ui/components/container";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { Toaster } from "@grasp-os/ui/components/toast";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  createFileRoute,
  Outlet,
  redirect,
  useLocation,
} from "@tanstack/react-router";

import { Page } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { hiddenAt, sectionAt } from "../settings/sections.ts";
import { settingsLayout } from "../settings/settings-nav.stylex.ts";
import { SettingsNav } from "../settings/settings-nav.tsx";
import { settingsToast } from "../settings/settings-toast.ts";

// Settings: one's own account, then the workspace and who may do what in
// it, one section at a time, each under its own name as the page's one
// header. The sections, their groups and who sees each are data
// (settings/sections.ts); the list of them stands beside the section, or
// above it where the page has no room for both (settings/settings-nav.tsx).
//
// A section stands in one column, Damsko's settings column (40rem): a
// settings page needs no more, and its rows read as one group. Only a
// section that needs the room (the Audit trail's log beside its details)
// says `wide` and keeps the rest of the page's width.
//
// Someone who follows a link to a section they may not see goes to their
// own profile, whichever section it is: core refuses them all the same,
// this only spares them a refusal.

const styles = stylex.create({
  // The page's own width is what decides whether the list fits beside.
  frame: { containerType: "inline-size", containerName: "settings" },
  row: {
    display: "flex",
    flexDirection: { default: "column", [settingsLayout.roomForList]: "row" },
    alignItems: {
      default: "stretch",
      [settingsLayout.roomForList]: "flex-start",
    },
    gap: { default: space[6], [settingsLayout.roomForList]: space[8] },
  },
  section: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: space[6],
    flexGrow: 1,
    minWidth: 0,
  },
});

/** Settings: the section the address names, under its name. */
const SettingsLayout = () => {
  const { t, i18n } = useLingui();
  const { pathname } = useLocation();
  const { identity } = Route.useRouteContext();
  const current = sectionAt(pathname, identity);
  const name = current === undefined ? t`Settings` : i18n._(current.label);
  const section = (
    <>
      {/* One header: the section's own name; the crumbs above already say Settings. */}
      <PageHeader size="sm" title={name} />
      <Outlet />
    </>
  );
  return (
    <>
      <SiteHeader
        crumbs={
          current === undefined
            ? [{ label: t`Settings` }]
            : [{ label: t`Settings` }, { label: name }]
        }
      />
      <Page wide>
        <div {...stylex.props(styles.frame)}>
          <div {...stylex.props(styles.row)}>
            <SettingsNav open={current} viewer={identity} />
            <div {...stylex.props(styles.section)}>
              {current?.wide === true ? (
                section
              ) : (
                <Container size="sm">
                  <div {...stylex.props(styles.section)}>{section}</div>
                </Container>
              )}
            </div>
          </div>
        </div>
      </Page>
      <Toaster toaster={settingsToast} />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings")({
  beforeLoad: ({ context: { identity }, location }) => {
    if (hiddenAt(location.pathname, identity)) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/settings/profile", replace: true });
    }
  },
  component: SettingsLayout,
});
