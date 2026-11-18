import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../grasp/tabs/index.ts";
import { grasp, media } from "../../grasp/tokens/tokens.stylex.ts";
import { Fold } from "./kern.tsx";

// A note's page, as the prototype lays it out
// (`components/brain-article/note-article.tsx`).

/** A tab at the side of a note's page: its details, its timeline, a conversation's topics. */
export interface SideTab {
  value: string;
  label: string;
  count?: number;
  content: ReactNode;
}

/** Where the window has room for the side beside the article. */
const WIDE = media.fromRail;

const styles = stylex.create({
  page: {
    display: "flex",
    flexGrow: 1,
    minHeight: 0,
  },
  article: {
    flexGrow: 1,
    minWidth: 0,
    overflowY: "auto",
  },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space6,
    boxSizing: "border-box",
    width: "100%",
    maxWidth: `calc(12 * ${grasp.space16})`,
    marginInline: "auto",
    paddingTop: grasp.space8,
    paddingBottom: grasp.space24,
    paddingInline: { default: grasp.space6, [media.fromTablet]: grasp.space12 },
  },
  // Too narrow for the side: its tabs fold in at the foot of the article instead.
  folded: {
    display: { default: "flex", [WIDE]: "none" },
    flexDirection: "column",
    gap: grasp.space1,
    paddingTop: grasp.space4,
    borderTopWidth: grasp.hairline,
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
  },
  footer: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    paddingTop: grasp.space4,
    borderTopWidth: grasp.hairline,
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
  },
  side: {
    display: { default: "none", [WIDE]: "flex" },
    flexDirection: "column",
    flexShrink: 0,
    boxSizing: "border-box",
    width: `calc(6 * ${grasp.space16})`,
    overflowY: "auto",
    paddingTop: grasp.space3,
    paddingBottom: grasp.space24,
    paddingInline: grasp.space5,
    backgroundColor: grasp.soft,
    borderInlineStartWidth: grasp.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: grasp.line,
  },
  count: {
    marginInlineStart: grasp.space2,
    color: grasp.muted,
  },
});

/**
 * A note's page in the brain. Less is more: the article is the banner, the title, a sentence or the
 * note's own text, and what was said, one kind at a time; the details and the timeline share the
 * side under tabs, which fold into the foot of the article where the window is too narrow for a
 * side. The page hands in its own pieces; this lays them out the same way for every kind of note.
 */
export const NoteArticle = ({
  toolbar,
  header,
  children,
  tabs,
  footer,
}: {
  toolbar: ReactNode;
  header: ReactNode;
  children: ReactNode;
  tabs: SideTab[];
  footer?: ReactNode;
}) => {
  // The tab beside the note: the first, or the one picked.
  const [side, setSide] = useState<string>();
  return (
    <div {...stylex.props(styles.page)}>
      <article {...stylex.props(styles.article)}>
        <div {...stylex.props(styles.column)}>
          {toolbar}
          {header}
          {children}
          {tabs.length > 0 ? (
            <div {...stylex.props(styles.folded)}>
              {tabs.map((tab) => (
                <Fold count={tab.count} key={tab.value} title={tab.label}>
                  {tab.content}
                </Fold>
              ))}
            </div>
          ) : null}
          {footer === undefined ? null : (
            <footer {...stylex.props(styles.footer)}>{footer}</footer>
          )}
        </div>
      </article>
      <aside {...stylex.props(styles.side)}>
        <Tabs
          onValueChange={(value) => {
            if (value !== null) {
              setSide(value);
            }
          }}
          value={tabs.some((tab) => tab.value === side) ? side : tabs[0]?.value}
        >
          <TabsList>
            {tabs.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
                {tab.count === undefined ? null : (
                  <span {...stylex.props(styles.count)}>{tab.count}</span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map((tab) => (
            <TabsContent key={tab.value} value={tab.value}>
              {tab.content}
            </TabsContent>
          ))}
        </Tabs>
      </aside>
    </div>
  );
};
