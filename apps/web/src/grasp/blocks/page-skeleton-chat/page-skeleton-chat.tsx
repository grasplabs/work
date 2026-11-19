// Page skeleton, chat: a chat's page before its messages arrive (a route's first paint, opening an
// old chat), built from the parts the page will show: the chat's column at the Composer's width,
// the Thread in its own `loading` (a person's message and the agent's answer, three pairs at the
// foot where the latest will stand, said once and busy), and under it the host's Composer in its
// `loading`, still in its own box. The page's bar is the host's (AppShellBar in its `loading`).
//
//   <AppShell bar="page" page="whole">
//     <AppShellBar crumbs={[]} loading />
//     <PageSkeletonChat aria-label="Chat" composer={<Composer aria-label="Message" loading onSend={send} />} />
//   </AppShell>
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Thread } from "../../thread";
import { grasp } from "../../tokens/tokens.stylex";

const styles = stylex.create({
  // The chat's column, as a chat's page lays it: the thread over the box, at the box's width.
  column: {
    display: "grid",
    gridTemplateRows: "minmax(0, 1fr) auto",
    rowGap: grasp.space4,
    boxSizing: "border-box",
    width: "100%",
    maxWidth: `calc(${grasp.composerWidth} + 2 * ${grasp.shellPageInline})`,
    height: "100%",
    minHeight: 0,
    marginInline: "auto",
    paddingInline: grasp.shellPageInline,
    paddingBottom: grasp.space4,
  },
});

const none: { id: string }[] = [];
const nothing = () => null;

export interface PageSkeletonChatProps {
  /** The thread's name for a screen reader, as the loaded chat's. */
  "aria-label"?: string;
  /** The host's own Composer, in its `loading`: it stands in the box it will have. */
  composer: ReactNode;
}

/** A chat before its messages: Thread's own loading pairs over the host's still Composer. */
export const PageSkeletonChat = ({
  "aria-label": label,
  composer,
}: PageSkeletonChatProps) => (
  <div data-slot="page-skeleton-chat" {...stylex.props(styles.column)}>
    <Thread aria-label={label} loading items={none} renderItem={nothing} />
    {composer}
  </div>
);
