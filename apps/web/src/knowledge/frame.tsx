import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { SiteHeader } from "../frame/site-header.tsx";
import type { Crumb } from "../frame/site-header.tsx";
import { Button } from "../grasp/button/index.ts";
import { SidebarToggle } from "../grasp/icons/index.ts";
import { Sheet, SheetContent, SheetTitle } from "../grasp/sheet/index.ts";
import { media } from "../grasp/tokens/tokens.stylex.ts";
import type { KnowledgeNavData } from "./nav-data.ts";
import { KnowledgeNav, KnowledgeTree } from "./nav.tsx";
import type { KnowledgeAt } from "./nav.tsx";

/**
 * Every Knowledge page: the site header, the navigation beside the page,
 * and on a phone the navigation in a sheet (grasplabs/prototype
 * `routes/brain.tsx`). The page beside it scrolls on its own.
 */

const styles = stylex.create({
  // Only on a phone: wider, the navigation stands beside the page.
  browse: { display: { default: null, [media.fromTablet]: "none" } },
  body: { display: "flex", flex: 1, minHeight: 0 },
  page: { display: "flex", flex: 1, minWidth: 0, minHeight: 0 },
});

export const KnowledgeFrame = ({
  crumbs,
  actions,
  data,
  at,
  children,
}: {
  crumbs: readonly Crumb[];
  actions?: ReactNode;
  data: KnowledgeNavData;
  at: KnowledgeAt;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  // On a phone the navigation is a sheet over the page: open on the page it
  // was opened on, so choosing anything in it closes it.
  const href = useRouterState({ select: (state) => state.location.href });
  const [openedAt, setOpenedAt] = useState<string>();
  const sheet = openedAt === href;
  const setSheet = (open: boolean): void => {
    setOpenedAt(open ? href : undefined);
  };
  return (
    <>
      <SiteHeader
        actions={
          <>
            <Button
              icon={SidebarToggle}
              layout={styles.browse}
              onClick={() => {
                setSheet(true);
              }}
              size="sm"
            >
              {t`Browse`}
            </Button>
            {actions}
          </>
        }
        crumbs={crumbs}
      />
      <div {...stylex.props(styles.body)}>
        <KnowledgeNav at={at} data={data} />
        <div {...stylex.props(styles.page)}>{children}</div>
      </div>
      <Sheet onOpenChange={setSheet} open={sheet} side="start">
        <SheetContent closeLabel={t`Close`}>
          <SheetTitle hidden>{t`Knowledge`}</SheetTitle>
          <KnowledgeTree at={at} data={data} />
        </SheetContent>
      </Sheet>
    </>
  );
};
