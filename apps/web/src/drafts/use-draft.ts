import type { Draft } from "@grasp-os/shared/drafts";
import type { Subject } from "@grasp-os/shared/subject";
import { RpcStub } from "capnweb";
import { useEffect, useState } from "react";

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

/** Lets go of a watch; one whose connection is gone already is let go. */
const releaseQuietly = async (subscription: {
  release: () => Promise<void>;
}): Promise<void> => {
  try {
    await subscription.release();
  } catch {
    // The connection is gone, and core drops the watch with it.
  }
};

/**
 * Follows the draft of `subject` over `core`: `onWritten` hears of each
 * write. Followed again on the next connection when the tab's drops; a
 * watch core refuses just ends, as the other reads still come. Returns
 * what stops it.
 */
const followDraft = (
  core: CoreConnection,
  subject: Subject,
  onWritten: () => void
): (() => void) => {
  let closed = false;
  let release: (() => void) | undefined;
  const watch = async (): Promise<void> => {
    try {
      const subscription = await core.withSession(
        async (session) =>
          await session.drafts.watch(subject, () => {
            onWritten();
          })
      );
      release = () => {
        void releaseQuietly(subscription);
        subscription[Symbol.dispose]();
      };
      if (closed) {
        release();
        return;
      }
      const stub: unknown = subscription;
      if (stub instanceof RpcStub) {
        stub.onRpcBroken(() => {
          if (!closed) {
            void watch();
          }
        });
      }
    } catch {
      // Refused or out of reach: the chat's writes and the page's own
      // still read it again.
    }
  };
  void watch();
  return () => {
    closed = true;
    release?.();
  };
};

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
