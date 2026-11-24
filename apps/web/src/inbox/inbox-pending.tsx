import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  SidePanel,
  SidePanelContent,
  SidePanelHeader,
} from "@grasp-os/ui/components/side-panel";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { radius, size } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { PagePanel } from "../frame/page-panel.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { inboxStyles } from "./inbox-styles.ts";

// The Inbox before what waits is read, as the reference's (#2503's
// routes/_shell.inbox.tsx `InboxPending`, its library's
// page-skeleton-list-detail): the list's rows waiting as Items do before
// their data, each a bare icon's box on its title's line, then its title's
// and its line's placeholders, no hairline between them; and the chosen
// item waiting in the frame's page panel, its head and its text as quiet
// lines, which the frame shows beside a wide page and keeps closed on a
// phone, as it does the loaded one.

/** How many rows wait: about a window's worth. */
const rows = 8;

/** Each paragraph's lines: a fixed run, so two loads draw the same shape. */
const paragraphs = [3, 2, 4];

const styles = stylex.create({
  // The bare icon's box: the placeholder fills it, so its ground is the
  // icon's 16px and its pixels the 8px inside (Damsko's empty ItemMedia
  // lets a control-tall placeholder run past it: registry gap of 25 Nov 2026).
  icon: {
    display: "flex",
    flexShrink: 0,
    width: size.iconSm,
    height: size.iconSm,
    overflow: "hidden",
    borderRadius: radius.sm,
  },
  fill: { height: "100%" },
  paragraph: { display: "grid" },
  // A paragraph's last line stops short, as a paragraph's does.
  last: { width: "60%" },
});

export const InboxPending = () => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(inboxStyles.page)}>
      <div {...stylex.props(inboxStyles.column)}>
        <SiteHeader crumbs={[{ label: t`Inbox` }]} />
        <div {...stylex.props(inboxStyles.list)}>
          <ItemGroup aria-label={t`What waits on you`}>
            {Array.from({ length: rows }, (_, index) => (
              <Item key={index} loading size="xs">
                <ItemMedia>
                  <span aria-hidden="true" {...stylex.props(styles.icon)}>
                    <Skeleton style={styles.fill} variant="rectangular" />
                  </span>
                </ItemMedia>
                <ItemContent>
                  <ItemTitle />
                  <ItemDescription />
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </div>
      </div>
      <PagePanel label={t`Inbox`} pageMinWidth={0}>
        <SidePanel aria-label={t`Inbox`}>
          <SidePanelHeader description="" loading title="" />
          <SidePanelContent>
            {paragraphs.map((lines, index) => (
              <div
                aria-hidden="true"
                key={index}
                {...stylex.props(styles.paragraph)}
              >
                {Array.from({ length: lines }, (__, line) => (
                  <Skeleton
                    key={line}
                    style={line === lines - 1 ? styles.last : undefined}
                  />
                ))}
              </div>
            ))}
          </SidePanelContent>
        </SidePanel>
      </PagePanel>
    </div>
  );
};
