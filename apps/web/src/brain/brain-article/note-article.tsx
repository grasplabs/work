import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { useState } from "react";
import type { ReactNode } from "react";

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
    <div className="flex min-h-0 flex-1">
      <article className="min-w-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pt-8 pb-28 md:px-12">
          {toolbar}
          {header}
          {children}
          {/* Too narrow for the side: its tabs fold in here instead. */}
          {tabs.length > 0 ? (
            <div className="flex flex-col gap-1 border-t pt-4 2xl:hidden">
              {tabs.map((tab) => (
                <Fold count={tab.count} key={tab.value} title={tab.label}>
                  {tab.content}
                </Fold>
              ))}
            </div>
          ) : null}
          {footer === undefined ? null : (
            <footer className="flex flex-col gap-1 border-t pt-4">
              {footer}
            </footer>
          )}
        </div>
      </article>
      <aside className="bg-sidebar hidden w-96 flex-none flex-col overflow-y-auto border-l px-5 pt-3 pb-28 2xl:flex">
        <Tabs
          onValueChange={(value: string) => {
            setSide(value);
          }}
          value={tabs.some((tab) => tab.value === side) ? side : tabs[0]?.value}
        >
          <TabsList variant="line">
            {tabs.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
                {tab.count === undefined ? null : (
                  <span className="text-muted-foreground font-normal">
                    {tab.count}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map((tab) => (
            <TabsContent key={tab.value} value={tab.value}>
              <div className="pt-4">{tab.content}</div>
            </TabsContent>
          ))}
        </Tabs>
      </aside>
    </div>
  );
};
