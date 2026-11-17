// What App shell (src/components/app-shell) tells a Sidebar it holds, wherever that Sidebar stands in
// what it was given: the shell's `sidebar` may be a bare <Sidebar> or a product's own component that
// renders one (<WorkSidebar /> with its data and hooks). The shell passes its part through this
// context, so it never needs the element to be a Sidebar and never copies it by its type.
"use client";

import { createContext, useContext } from "react";
import type { ReactNode } from "react";

/** What App shell asks of the Sidebar inside it. */
export interface SidebarInShell {
  /** Its column beside the page, or the sheet a narrow shell opens it in. */
  place: "column" | "sheet";
  /** In the column: the reopen button's look, unless the Sidebar sets its own. */
  reopenLook?: "raised" | "quiet";
  /** The product's mark and name for the head, when the shell puts the brand there. */
  brand?: ReactNode;
  /** In the column: the bar's brand, for the head while it peeks over the bar (FRESH.md F76). */
  peekBrand?: ReactNode;
  /** In the sheet: the close button at the head's end. */
  headEnd?: ReactNode;
  /** In the sheet: what stands under the head (the section switch). */
  headBelow?: ReactNode;
  /** In the column: told each time it is open or folded, at first too, so the shell's bar follows. */
  onOpen?: (open: boolean) => void;
  /** In the column: told each time it starts or stops peeking, so the shell's bar fades what the
   * peek covers (FRESH.md F76). */
  onPeek?: (peeking: boolean) => void;
}

const SidebarShellContext = createContext<SidebarInShell | null>(null);

/** The shell's side of it: wraps what the shell was given as its sidebar. */
export const SidebarShellProvider = SidebarShellContext.Provider;

/** The Sidebar's side: what the shell around it asks, or null outside a shell. */
export const useSidebarInShell = () => useContext(SidebarShellContext);
