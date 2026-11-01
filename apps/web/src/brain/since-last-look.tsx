import type { BrainChange, BrainChangePage } from "@grasp-os/shared/brain";
import { failureText } from "@grasp-os/shared/errors";
import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useRouteContext } from "@tanstack/react-router";
import { FileTextIcon, InboxIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { useCore } from "../use-core.ts";
import { keepLooked, lastLooked } from "./last-looked.ts";

// What changed in the brain since the person last looked at its activity
// (`brain.changes`): the Knowledge documents added or changed since, and,
// for admins, the sources the onboarding gave it, newest first, a page at
// a time. Core says only what the person may read; the log below it
// (brain-log.tsx) is built from what the brain holds, this from what
// changed. Once read, the moment it was asked counts as their last look.

/** How many changes a page shows. */
const pageSize = 20;

/** What a read of the changes came to. */
type Read =
  | { state: "loading" }
  | { state: "failed"; reason: string }
  | {
      state: "ready";
      /** The moment it shows changes after: the last look, as it was read. */
      since: string;
      changes: BrainChange[];
      next: string | null;
    };

/**
 * A page of the changes after `since`, from `cursor`. Outside the
 * component, as the React Compiler can't compile `try`/`catch` around a
 * value it returns.
 */
const readChanges = async (
  core: Pick<CoreConnection, "withSession">,
  since: string,
  cursor?: string
): Promise<{ page: BrainChangePage } | { reason: string }> => {
  try {
    const page = await core.withSession(
      async (session) =>
        await session.brain.changes({
          since,
          limit: pageSize,
          ...(cursor === undefined ? {} : { cursor }),
        })
    );
    return { page };
  } catch (error) {
    return { reason: failureText(error) };
  }
};

/** One change: what it is, and a link to it. */
const ChangeLine = ({ change }: { change: BrainChange }) => {
  const at = formatDateTime(change.at);
  if (change.kind === "source") {
    return (
      <li className="flex items-center gap-2.5 py-2">
        <InboxIcon
          aria-hidden="true"
          className="text-muted-foreground size-4 flex-none"
        />
        <Link
          className="min-w-0 flex-1 truncate font-medium hover:underline"
          params={{ noteId: change.source.id }}
          to="/brain/$noteId"
        >
          {change.source.title}
        </Link>
        <span className="text-muted-foreground flex-none text-xs">
          <Trans>Came in {at}</Trans>
        </span>
      </li>
    );
  }
  const { document } = change;
  return (
    <li className="flex items-center gap-2.5 py-2">
      <FileTextIcon
        aria-hidden="true"
        className="text-muted-foreground size-4 flex-none"
      />
      <Link
        className="min-w-0 flex-1 truncate font-medium hover:underline"
        params={{ collection: document.collectionId }}
        search={{ doc: document.id }}
        to="/knowledge/$collection"
      >
        {document.title}
      </Link>
      <span className="text-muted-foreground flex-none text-xs">
        {change.change === "added" ? (
          <Trans>Added {at}</Trans>
        ) : (
          <Trans>Changed {at}</Trans>
        )}
      </span>
    </li>
  );
};

/** "Since you last looked", above the brain's log. */
export const SinceLastLook = () => {
  const { t } = useLingui();
  const core = useCore();
  const { identity } = useRouteContext({ from: "/_shell" });
  const [read, setRead] = useState<Read>({ state: "loading" });
  const [more, setMore] = useState(false);
  useEffect(() => {
    let left = false;
    const asked = new Date();
    // Read as the page opens: the moment it shows changes after.
    const since = lastLooked(identity.userId, asked);
    const load = async (): Promise<void> => {
      const answer = await readChanges(core, since);
      if (left) {
        return;
      }
      if ("reason" in answer) {
        setRead({ state: "failed", reason: answer.reason });
        return;
      }
      setRead({ state: "ready", since, ...answer.page });
      // Seen: the next look starts from when this one asked.
      keepLooked(identity.userId, asked);
    };
    void load();
    return () => {
      left = true;
    };
  }, [core, identity.userId]);

  const showMore = async (
    since: string,
    shown: BrainChange[],
    cursor: string
  ): Promise<void> => {
    setMore(true);
    const answer = await readChanges(core, since, cursor);
    setMore(false);
    if ("reason" in answer) {
      setRead({ state: "failed", reason: answer.reason });
      return;
    }
    setRead({
      state: "ready",
      since,
      changes: [...shown, ...answer.page.changes],
      next: answer.page.next,
    });
  };

  const when = read.state === "ready" ? formatDateTime(read.since) : "";
  return (
    <section
      aria-labelledby="since-last-look"
      className="bg-card flex flex-col gap-2 rounded-xl border px-4 py-3"
    >
      <h2 className="text-sm font-medium" id="since-last-look">
        <Trans>Since you last looked</Trans>
      </h2>
      {read.state === "failed" ? <ErrorText>{read.reason}</ErrorText> : null}
      {read.state === "ready" && read.changes.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          <Trans>Nothing has changed since {when}.</Trans>
        </p>
      ) : null}
      {read.state === "ready" && read.changes.length > 0 ? (
        <>
          <ul
            aria-label={t`Changes since ${when}`}
            className="flex flex-col divide-y text-sm"
          >
            {read.changes.map((change) => (
              <ChangeLine
                change={change}
                key={
                  change.kind === "source"
                    ? `source:${change.source.id}`
                    : `document:${change.document.id}`
                }
              />
            ))}
          </ul>
          {read.next === null ? null : (
            <div>
              <Button
                disabled={more}
                onClick={() => {
                  if (read.next !== null) {
                    void showMore(read.since, read.changes, read.next);
                  }
                }}
                size="sm"
                variant="outline"
              >
                <Trans>Show more</Trans>
              </Button>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
};
