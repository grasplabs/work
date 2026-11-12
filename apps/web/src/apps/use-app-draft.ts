import type { AppDraft } from "@grasp-os/shared/app-drafts";
import { RpcStub } from "capnweb";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

// An App's draft, shared by everyone who builds it (core's app-drafts.ts),
// as its workspace reads it: again whenever core says it was written,
// whoever wrote it (`apps.drafts.watch`), whenever the chat beside it says
// its agent wrote (`worked`), and whenever the workspace changed it itself
// (`reread`). So another builder's writes come into the preview at once.

/**
 * Whether the draft has changes only its builders see: files, or its
 * definition alone. None while it isn't read yet.
 */
export const hasChanges = (draft: AppDraft | undefined): boolean =>
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
 * Follows the draft of `app` over `core`: `onWritten` hears of each
 * write. Followed again on the next connection when the tab's drops; a
 * watch core refuses just ends, as the other reads still come. Returns
 * what stops it.
 */
const followDraft = (
  core: CoreConnection,
  app: string,
  onWritten: () => void
): (() => void) => {
  let closed = false;
  let release: (() => void) | undefined;
  const watch = async (): Promise<void> => {
    try {
      const subscription = await core.withSession(
        async (session) =>
          await session.apps.drafts.watch(app, () => {
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
      // Refused or out of reach: the chat's writes and the workspace's
      // own still read it again.
    }
  };
  void watch();
  return () => {
    closed = true;
    release?.();
  };
};

/** The App's draft as read last; undefined until the first read lands. */
export const useAppDraft = (
  app: string,
  /** The count of the chat's writes (`ChatState.worked`): a change reads again. */
  worked: number
): { draft: AppDraft | undefined; reread: () => void } => {
  const core = useCore();
  const [read, setRead] = useState<AppDraft>();
  const [reads, setReads] = useState(0);
  const reread = (): void => {
    setReads((before) => before + 1);
  };
  useEffect(
    () =>
      followDraft(core, app, () => {
        setReads((before) => before + 1);
      }),
    [core, app]
  );
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      const found = await loadFromCore(
        core,
        async (session) => await session.apps.drafts.get(app)
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
  }, [core, app, worked, reads]);
  return {
    draft: read?.app === app ? read : undefined,
    reread,
  };
};
