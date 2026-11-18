import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { focus } from "../grasp/focus/focus.ts";
import { toast } from "../grasp/toast/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

const styles = stylex.create({
  // The cited words, as a link in the text reads: underlined, in its ink.
  note: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "inherit",
    font: "inherit",
    textDecorationLine: "underline",
    textDecorationColor: grasp.linkUnderline,
    textUnderlineOffset: grasp.linkUnderlineOffset,
    cursor: "pointer",
  },
});

// A note an answer cites (`ChatCitation`): its link opens the document on
// its collection's page (`?doc=`, as `documentHref` addresses one). The
// answer names only its ID, so the document is looked up when the link
// is followed, as the person reading it, never before: a note they can't
// read, or that is gone, opens nothing and says so.

/** The address a cited note's link carries in an answer. */
export const citedNoteLink = /^grasp:note\/(?<id>[\w-]{1,128})$/u;

/** A link to note `documentId`, one the answer cites. */
export const CitedNote = ({
  documentId,
  children,
}: {
  documentId: string;
  children?: ReactNode;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const navigate = useNavigate();
  const open = async (): Promise<void> => {
    const found = await loadFromCore(
      core,
      async (session) => await session.knowledge.getDocument(documentId)
    );
    if (found.state !== "ready") {
      toast.error({
        title: t`This note can't be opened`,
        description:
          found.state === "offline"
            ? t`Grasp can't be reached right now. Try again in a moment.`
            : t`It's gone, or you can't read it.`,
      });
      return;
    }
    await navigate({
      to: "/knowledge/$collection",
      params: { collection: found.data.collectionId },
      search: { doc: documentId },
    });
  };
  return (
    <button
      onClick={() => {
        void open();
      }}
      type="button"
      {...stylex.props(styles.note, focus.ring)}
    >
      {children}
    </button>
  );
};
