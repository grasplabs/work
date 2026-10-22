import type { ChatDraft, ChatDraftVersion } from "@grasp-os/shared/chat";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { useCore } from "../use-core.ts";

// The versions of a chat's draft of an App, in the studio's bar (as the
// prototype's `components/apps/app-studio.tsx` reads "Version N of M"):
// core keeps every write of the draft as a version, and the person steps
// back through them to preview an earlier one, read-only, then returns to
// the latest. Read again at each of the draft's writes.

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

/**
 * "Version N of M" for the chat's draft, with the way to an earlier or
 * later one (`onShow`, undefined for the latest). An earlier one reads as
 * read-only, with the way back to the latest.
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
    return null;
  }
  const latest = newest.number;
  const number = shown ?? latest;
  const earlier = number < latest;
  const toShow = (to: number): number | undefined =>
    to >= latest ? undefined : to;
  return (
    <div className="flex flex-none items-center gap-1">
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
      {earlier ? (
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
      ) : null}
    </div>
  );
};
