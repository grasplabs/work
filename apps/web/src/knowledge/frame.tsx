import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { SiteHeader } from "../frame/site-header.tsx";
import type { Crumb } from "../frame/site-header.tsx";
import type { KnowledgeNavData } from "./nav-data.ts";
import type { KnowledgeAt } from "./nav.tsx";

// Concept B: every Knowledge page with no navigation beside it; the page
// takes the whole card, and search stands on the overview.

const styles = stylex.create({
  body: { display: "flex", flex: 1, minHeight: 0 },
  page: { display: "flex", flex: 1, minWidth: 0, minHeight: 0 },
});

export const KnowledgeFrame = ({
  crumbs,
  actions,
  children,
}: {
  crumbs: readonly Crumb[];
  actions?: ReactNode;
  data: KnowledgeNavData;
  at: KnowledgeAt;
  children: ReactNode;
}) => (
  <>
    <SiteHeader actions={actions} crumbs={crumbs} />
    <div {...stylex.props(styles.body)}>
      <div {...stylex.props(styles.page)}>{children}</div>
    </div>
  </>
);
