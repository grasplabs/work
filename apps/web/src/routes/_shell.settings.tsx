import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  createFileRoute,
  Link,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";

import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { ActiveBar } from "../grasp/active-bar/index.ts";
import { focus } from "../grasp/focus/focus.ts";
import { Icon } from "../grasp/icons/index.ts";
import { Select } from "../grasp/select/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { groupedSectionsFor } from "../settings/sections.ts";
import type {
  SettingsGroup,
  SettingsHref,
  SettingsSection,
} from "../settings/sections.ts";

// Settings: the workspace and who may do what in it, then one's own
// account, one section at a time, each under its own name as the page's
// one header. The sections, their groups and who sees
// each are data (settings/sections.ts); this lists them beside the
// section, until Grasp UI's Sidebar can take them over.

// Whether the page (not the window: Grasp's own sidebar takes its share)
// has the room for the list of sections beside the section.
const WIDE = "@container (width >= 48rem)";

const styles = stylex.create({
  frame: { containerType: "inline-size" },
  columns: {
    display: "flex",
    flexDirection: { default: "column", [WIDE]: "row" },
    alignItems: { default: "stretch", [WIDE]: "flex-start" },
    gap: { default: grasp.space6, [WIDE]: grasp.space8 },
  },
  // On a narrow page the sections are one control above the section.
  picker: { display: { default: "block", [WIDE]: "none" } },
  nav: {
    display: { default: "none", [WIDE]: "flex" },
    flexDirection: "column",
    gap: grasp.space5,
    flexShrink: 0,
    width: grasp.outlineWidth,
    position: "sticky",
    top: grasp.space16,
  },
  group: { display: "flex", flexDirection: "column", gap: grasp.space1 },
  groupTitle: { paddingInline: grasp.space3 },
  // The list Active bar slides in: relative, its items each active-bar-item tall.
  list: { position: "relative", display: "flex", flexDirection: "column" },
  item: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    height: grasp.activeBarItem,
    paddingInline: grasp.space3,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    textDecorationLine: "none",
    color: {
      default: grasp.muted,
      ":hover": { default: null, [media.hover]: grasp.ink },
    },
    // On a touch screen each item is pressed over 44px, drawn as before.
    "::after": {
      content: '""',
      position: "absolute",
      insetInline: 0,
      insetBlock: {
        default: 0,
        [media.coarse]: `calc((${grasp.activeBarItem} - ${grasp.tap}) / 2)`,
      },
    },
  },
  current: { color: grasp.ink },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space5,
    flexGrow: 1,
    minWidth: 0,
  },
});

/** One group's links, the current one marked by Active bar. */
const SectionLinks = ({
  group,
  sections,
  current,
}: {
  group: SettingsGroup;
  sections: SettingsSection[];
  current: SettingsHref | undefined;
}) => {
  const { i18n } = useLingui();
  const index = sections.findIndex((section) => section.href === current);
  return (
    <div {...stylex.props(styles.group)}>
      <div {...stylex.props(styles.groupTitle)}>
        <Text element="span" size="xs" tone="muted">
          {i18n._(group.title)}
        </Text>
      </div>
      <div {...stylex.props(styles.list)}>
        <ActiveBar {...(index === -1 ? {} : { index })} />
        {sections.map((section) => (
          <Link
            aria-current={section.href === current ? "page" : undefined}
            key={section.id}
            to={section.href}
            {...stylex.props(
              styles.item,
              section.href === current && styles.current,
              focus.ring
            )}
          >
            <Icon icon={section.icon} />
            {i18n._(section.label)}
          </Link>
        ))}
      </div>
    </div>
  );
};

/**
 * Settings: the workspace and who may do what in it, then one's own account. One section at a time.
 * The list of sections stands beside the section only where the page has the room for both. With
 * less room the sections are one control above the section, so a section is never squeezed.
 */
const SettingsLayout = () => {
  const { t, i18n } = useLingui();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { identity } = Route.useRouteContext();
  const groups = groupedSectionsFor(identity);
  const sections = groups.flatMap((each) => each.sections);
  const current = sections.find((section) => pathname.startsWith(section.href));
  return (
    <>
      <SiteHeader
        crumbs={
          current === undefined
            ? [{ label: t`Settings` }]
            : [{ label: t`Settings` }, { label: i18n._(current.label) }]
        }
      />
      <Page wide>
        <div {...stylex.props(styles.frame)}>
          <div {...stylex.props(styles.columns)}>
            <div {...stylex.props(styles.picker)}>
              <Select
                aria-label={t`Settings`}
                items={groups.map((each) => ({
                  type: "group" as const,
                  label: i18n._(each.group.title),
                  items: each.sections.map((section) => ({
                    value: section.href,
                    label: i18n._(section.label),
                  })),
                }))}
                onValueChange={(value) => {
                  const to = sections.find(
                    (section) => section.href === value
                  )?.href;
                  if (to !== undefined) {
                    void navigate({ to });
                  }
                }}
                value={current?.href ?? null}
              />
            </div>
            <nav aria-label={t`Settings`} {...stylex.props(styles.nav)}>
              {groups.map((each) => (
                <SectionLinks
                  current={current?.href}
                  group={each.group}
                  key={each.group.id}
                  sections={each.sections}
                />
              ))}
            </nav>
            <div {...stylex.props(styles.section)}>
              {/* One header: the section's own name; the crumbs above already say Settings. */}
              <PageHeading
                title={
                  current === undefined ? t`Settings` : i18n._(current.label)
                }
              />
              <Outlet />
            </div>
          </div>
        </div>
      </Page>
    </>
  );
};

export const Route = createFileRoute("/_shell/settings")({
  component: SettingsLayout,
});
