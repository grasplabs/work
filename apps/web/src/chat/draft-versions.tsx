import type { ChatDraft, ChatDraftVersion } from "@grasp-os/shared/chat";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// The versions of a chat's draft of an App, in the studio's bar (as the
// prototype's `components/apps/app-studio.tsx` reads "Version N of M"):
// core keeps every write of the draft as a version, and the person steps
// back through them to preview an earlier one, read-only, then returns to
// the latest, or restores it as the draft's newest version; or discards
// the draft, its versions kept to restore one. Read again at each of the
// draft's writes.

/** A version the person opened, at the draft's revision they opened it on. */
export interface ShownVersion {
  app: string;
  revision: number;
  number: number;
}

/**
 * The chat's versions of the draft of `app`, newest first; none when they
 * didn't load, which only leaves the count out. Outside the component, as
 * the React Compiler can't compile `try`.
 */
const readVersions = async (
  core: Pick<CoreConnection, "withSession">,
  chatId: string,
  app: string
): Promise<ChatDraftVersion[]> => {
  try {
    return await core.withSession(
      async (session) => await session.chats.draftVersions(chatId, app)
    );
  } catch {
    return [];
  }
};

/**
 * The version of `draft` shown: the one the person opened, while the
 * draft is still at the revision they opened it on; otherwise the latest
 * (undefined), so a new write brings them back to it.
 */
export const shownVersion = (
  draft: ChatDraft,
  opened: ShownVersion | undefined
): number | undefined =>
  opened?.app === draft.app && opened.revision === draft.revision
    ? opened.number
    : undefined;

/** What an earlier version open reads as: read-only, with the way back to the latest. */
const ReadOnlyBack = ({ onShow }: { onShow: (version?: number) => void }) => (
  <>
    <Badge variant="secondary">
      <Trans>Read-only</Trans>
    </Badge>
    <Button
      onClick={() => {
        onShow();
      }}
      size="sm"
      variant="ghost"
    >
      <Trans>Back to latest</Trans>
    </Button>
  </>
);

/** Asks before discarding the draft: the agent's next write starts over. */
const DiscardDialog = ({
  open,
  onOpenChange,
  onDiscard,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDiscard: () => void;
}) => (
  <AlertDialog onOpenChange={onOpenChange} open={open}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          <Trans>Discard this draft?</Trans>
        </AlertDialogTitle>
        <AlertDialogDescription>
          <Trans>
            The draft&apos;s changes go, and the agent&apos;s next change starts
            over from the app as it is. Its versions are kept, so you can
            restore one.
          </Trans>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>
          <Trans>Cancel</Trans>
        </AlertDialogCancel>
        <AlertDialogAction onClick={onDiscard} variant="destructive">
          <Trans>Discard</Trans>
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

/**
 * What the person does with the draft from its bar: restore the earlier
 * version they opened (`shown`) as its newest, then see it; or, on the
 * latest, discard the draft, once they confirm.
 */
const DraftActions = ({
  chatId,
  app,
  shown,
  onShow,
}: {
  chatId: string;
  app: string;
  shown: number | undefined;
  onShow: (version?: number) => void;
}) => {
  const { busy, failure, run } = useCoreAction();
  const [asking, setAsking] = useState(false);
  const restore = async (version: number): Promise<void> => {
    const restored = await run(
      async (session) =>
        await session.chats.restoreDraftVersion(chatId, app, version)
    );
    if (restored !== undefined) {
      onShow();
    }
  };
  const discard = async (): Promise<void> => {
    await run(async (session) => {
      await session.chats.discardDraft(chatId, app);
    });
  };
  return (
    <>
      {shown === undefined ? (
        <Button
          disabled={busy}
          onClick={() => {
            setAsking(true);
          }}
          size="sm"
          variant="ghost"
        >
          <Trans>Discard draft</Trans>
        </Button>
      ) : (
        <Button
          disabled={busy}
          onClick={() => {
            void restore(shown);
          }}
          size="sm"
          variant="outline"
        >
          <Trans>Restore this version</Trans>
        </Button>
      )}
      <ErrorText>{failure}</ErrorText>
      <DiscardDialog
        onDiscard={() => {
          void discard();
        }}
        onOpenChange={setAsking}
        open={asking}
      />
    </>
  );
};

/**
 * "Version N of M" for the chat's draft, with the way to an earlier or
 * later one (`onShow`, undefined for the latest). An earlier one reads as
 * read-only, with the way back to the latest and to restore it; the
 * latest, with the way to discard the draft.
 */
export const DraftVersionBar = ({
  chatId,
  draft,
  shown,
  onShow,
}: {
  chatId: string;
  draft: ChatDraft;
  shown: number | undefined;
  onShow: (version?: number) => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const [read, setRead] = useState<{
    key: string;
    versions: ChatDraftVersion[];
  }>();
  const key = `${draft.app}:${draft.revision}`;
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      const versions = await readVersions(core, chatId, draft.app);
      if (current) {
        setRead({ key, versions });
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [core, chatId, draft.app, key]);
  const versions = read?.key === key ? read.versions : [];
  const [newest] = versions;
  if (newest === undefined) {
    // Unread (or not read yet), an earlier version still open keeps the
    // way back to the latest.
    return shown === undefined ? null : (
      <div className="flex flex-wrap items-center gap-1">
        <ReadOnlyBack onShow={onShow} />
      </div>
    );
  }
  const latest = newest.number;
  const number = shown ?? latest;
  const earlier = number < latest;
  const toShow = (to: number): number | undefined =>
    to >= latest ? undefined : to;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button
        aria-label={t`Earlier version`}
        disabled={number <= 1}
        onClick={() => {
          onShow(toShow(number - 1));
        }}
        size="icon-sm"
        variant="ghost"
      >
        <ChevronLeftIcon />
      </Button>
      <span className="text-muted-foreground text-xs whitespace-nowrap">
        <Trans>
          Version {number} of {latest}
        </Trans>
      </span>
      <Button
        aria-label={t`Later version`}
        disabled={!earlier}
        onClick={() => {
          onShow(toShow(number + 1));
        }}
        size="icon-sm"
        variant="ghost"
      >
        <ChevronRightIcon />
      </Button>
      {earlier ? <ReadOnlyBack onShow={onShow} /> : null}
      <DraftActions
        app={draft.app}
        chatId={chatId}
        onShow={onShow}
        shown={earlier ? number : undefined}
      />
    </div>
  );
};
