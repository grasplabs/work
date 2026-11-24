import type { Role } from "@grasp-os/shared/roles";
import { Button } from "@grasp-os/ui/components/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Text } from "@grasp-os/ui/components/text";
import { Icon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useNavigate } from "@tanstack/react-router";

import { groupedSectionsFor } from "./sections.ts";
import type { SettingsSection } from "./sections.ts";
import { settingsLayout } from "./settings-nav.stylex.ts";

// Settings' own list of its sections, inside the page while the app's
// sidebar doesn't list them: beside the section where the page has the
// room for both (which is about the page, not the window: the sidebar
// takes its share), and one control above the section where it hasn't, so
// a section is never squeezed into a sliver. Once the frame lists the
// sections in its sidebar (settings/sections.ts is the data for it), the
// wide list goes from here and the control stays for a phone.

const styles = stylex.create({
  list: {
    display: { default: "none", [settingsLayout.roomForList]: "flex" },
    flexDirection: "column",
    gap: space[5],
    width: "13rem",
    flexShrink: 0,
    position: "sticky",
    top: space[6],
  },
  // Each link as wide as its words, the open one's fill round them.
  group: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space[1],
  },
  // The group's name, where the links' words start. A flex item, it has
  // its own small line (20px), not the list's 24px one it stood in inside
  // a wrapper: the space above puts the links back where that line had
  // them.
  groupName: {
    marginInline: space[2],
    marginBlockStart: space[1],
    marginBlockEnd: space[1],
  },
  // The trigger's own display, gone where the list has room.
  control: {
    display: { default: "flex", [settingsLayout.roomForList]: "none" },
  },
});

interface Viewer {
  role: Role;
  staff: boolean;
}

/** One section's link in the list: the open one drawn as chosen. */
const SectionLink = ({
  section,
  open,
}: {
  section: SettingsSection;
  open: boolean;
}) => {
  const { i18n } = useLingui();
  return (
    <Button asChild size="sm" variant={open ? "secondary" : "ghost"}>
      <Link aria-current={open ? "page" : undefined} to={section.href}>
        <Icon icon={section.icon} />
        {i18n._(section.label)}
      </Link>
    </Button>
  );
};

/** The sections, beside the section where there is room, else one control above it. */
export const SettingsNav = ({
  viewer,
  open,
}: {
  viewer: Viewer;
  /** The section open now, if it is one they may open. */
  open: SettingsSection | undefined;
}) => {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const groups = groupedSectionsFor(viewer);
  const listed = groups.flatMap(({ sections }) => sections);
  // A section they may read but don't find listed (a member's Workspace) is
  // chosen in neither list; the control still names it, as the page they
  // are on, without offering it among the choices.
  const chosen = listed.find(({ id }) => id === open?.id);
  const named = chosen === undefined && open !== undefined ? [open] : [];
  return (
    <>
      <nav aria-label={t`Settings`} {...stylex.props(styles.list)}>
        {groups.map(({ group, sections }) => (
          <div key={group.id} {...stylex.props(styles.group)}>
            <Text as="span" color="muted" size="xs" style={styles.groupName}>
              {i18n._(group.title)}
            </Text>
            {sections.map((section) => (
              <SectionLink
                key={section.id}
                open={section.id === chosen?.id}
                section={section}
              />
            ))}
          </div>
        ))}
      </nav>
      <Select
        items={[...listed, ...named].map((section) => ({
          value: section.href,
          label: i18n._(section.label),
        }))}
        onValueChange={(value) => {
          const section = listed.find(({ href }) => href === value);
          if (section !== undefined) {
            void navigate({ to: section.href });
          }
        }}
        value={open?.href ?? null}
      >
        <SelectTrigger aria-label={t`Settings`} style={styles.control}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {groups.map(({ group, sections }) => (
            <SelectGroup key={group.id}>
              <SelectLabel>{i18n._(group.title)}</SelectLabel>
              {sections.map((section) => (
                <SelectItem key={section.id} value={section.href}>
                  {i18n._(section.label)}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </>
  );
};
