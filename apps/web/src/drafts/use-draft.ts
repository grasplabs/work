import type { Draft } from "@grasp-os/shared/drafts";
import type { Subject } from "@grasp-os/shared/subject";
import { useEffect, useState } from "react";

import { follow } from "../chat/follow-chat.ts";
import type { CoreConnection } from "../core-connection.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

// The draft of an App or a workflow, shared by everyone who builds it
// (core's drafts.ts), as its page reads it: again whenever core says it
// was written, whoever wrote it (`drafts.watch`), whenever the chat beside
// it says its agent wrote (`worked`), and whenever the page changed it
// itself (`reread`). So another builder's writes come into the page at
// once, an App's preview and a workflow's Flow alike.

/**
 * Whether the draft has changes only its builders see: files, or an
 * App's definition alone. None while it isn't read yet.
 */
export const hasChanges = (draft: Draft | undefined): boolean =>
  draft !== undefined && (draft.changed.length > 0 || draft.definitionChanged);

/**
 * Follows the draft of `subject` over `core`: `onWritten` hears of each
 * write, and of what may have been written while it wasn't followed, as
 * it is followed again (follow-chat.ts `follow`, which follows again as
 * it says). A refusal (no longer a builder of it) ends it, as the other
 * reads still come. Returns what stops it.
 */
const followDraft = (
  core: CoreConnection,
  subject: Subject,
  onWritten: () => void
): (() => void) =>
  follow(
    core,
    async (session, ended) =>
      await session.drafts.watch(
        subject,
        Object.assign(
          () => {
            onWritten();
          },
          { [Symbol.dispose]: ended }
        )
      ),
    () => {
      // Refused or out of reach: the chat's writes and the page's own
      // still read it again.
    },
    // Whatever was written while it wasn't followed is read again.
    { onDropped: onWritten }
  );

/**
 * The subject's draft as read last; undefined until the first read lands,
 * and for no subject (`undefined`: one the person doesn't build), which
 * reads nothing.
 */
export const useDraft = (
  subject: Subject | undefined,
  /** The count of the chat's writes (`ChatState.worked`): a change reads again. */
  worked: number
): { draft: Draft | undefined; reread: () => void } => {
  const core = useCore();
  const kind = subject?.kind;
  const id = subject?.id;
  const [read, setRead] = useState<Draft>();
  const [reads, setReads] = useState(0);
  const reread = (): void => {
    setReads((before) => before + 1);
  };
  useEffect(() => {
    if (kind === undefined || id === undefined) {
      return () => {
        // Nothing followed.
      };
    }
    return followDraft(core, { kind, id }, () => {
      setReads((before) => before + 1);
    });
  }, [core, kind, id]);
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      if (kind === undefined || id === undefined) {
        return;
      }
      const found = await loadFromCore(
        core,
        async (session) => await session.drafts.get({ kind, id })
      );
      // A read that fails leaves the one before: the next write reads again.
      if (current && found.state === "ready") {
        setRead(found.data);
      }
    };
    void load();
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `worked` and `reads` say when to read again
  }, [core, kind, id, worked, reads]);
  return {
    draft:
      read?.subject.kind === kind && read?.subject.id === id ? read : undefined,
    reread,
  };
};
