import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { SiteHeader } from "../frame/site-header.tsx";
import { inboxStyles } from "./inbox-styles.ts";

// The Inbox before what waits is read: the list's rows waiting as Damsko's
// Items do before their data, each part a quiet placeholder of its own
// size, where the list will stand.

/** How many rows wait: about a window's worth. */
const rows = 8;

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
                <ItemMedia />
                <ItemContent>
                  <ItemTitle />
                  <ItemDescription />
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </div>
      </div>
    </div>
  );
};
