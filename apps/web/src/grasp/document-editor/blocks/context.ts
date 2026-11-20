// What the blocks' own views need from the editor round them: its words, and what the host runs
// when a person asks Grasp again for one part. Node views are drawn in a portal of the editor's tree,
// so this context reaches them.
"use client";

import { createContext, use } from "react";

import { documentEditorWords } from "../words";
import type { DocumentEditorWords } from "../words";

/** One part asked again: its question (an Ask block's, or a section's summary) and its Markdown now. */
export interface AskAgainRequest {
  kind: "ask" | "section";
  question: string;
  markdown: string;
}

export interface BlocksContextValue {
  words: DocumentEditorWords;
  /** Runs when a person asks again; resolves with the part's new Markdown. None: no Ask again. */
  askAgain: ((request: AskAgainRequest) => Promise<string>) | undefined;
}

export const BlocksContext = createContext<BlocksContextValue>({
  words: documentEditorWords,
  askAgain: undefined,
});

export const useBlocks = () => use(BlocksContext);
