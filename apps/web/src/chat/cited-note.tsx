import { toast } from "@grasp-os/ui/components/toast";
import { useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { loadFromCore } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

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
      toast.add({
        type: "error",
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
      className="underline"
      onClick={() => {
        void open();
      }}
      type="button"
    >
      {children}
    </button>
  );
};
