import type { BrainChange, BrainChangePage } from "@grasp-os/shared/brain";
import { failureText } from "@grasp-os/shared/errors";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouteContext } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { File, Inbox } from "../grasp/icons/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
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

const styles = stylex.create({
  body: { display: "flex", flexDirection: "column", gap: grasp.space2 },
  start: { alignSelf: "flex-start" },
});

/** One change: what it is, and a link to it; the whole row opens it. */
const ChangeLine = ({ change }: { change: BrainChange }) => {
  const at = formatDateTime(change.at);
  if (change.kind === "source") {
    return (
      <Item
        render={
          <Link params={{ noteId: change.source.id }} to="/brain/$noteId" />
        }
        size="xs"
      >
        <ItemMedia icon={Inbox} iconLook="inline" />
        <ItemContent>
          <ItemTitle>{change.source.title}</ItemTitle>
          <ItemDescription>
            <Trans>Came in {at}</Trans>
          </ItemDescription>
        </ItemContent>
      </Item>
    );
  }
  const { document } = change;
  return (
    <Item
      render={
        <Link
          params={{ collection: document.collectionId }}
          search={{ doc: document.id }}
          to="/knowledge/$collection"
        />
      }
      size="xs"
    >
      <ItemMedia icon={File} iconLook="inline" />
      <ItemContent>
        <ItemTitle>{document.title}</ItemTitle>
        <ItemDescription>
          {change.change === "added" ? (
            <Trans>Added {at}</Trans>
          ) : (
            <Trans>Changed {at}</Trans>
          )}
        </ItemDescription>
      </ItemContent>
    </Item>
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
    <SectionCard density="compact" title={<Trans>Since you last looked</Trans>}>
      <div {...stylex.props(styles.body)}>
        {read.state === "failed" ? <ErrorText>{read.reason}</ErrorText> : null}
        {read.state === "ready" && read.changes.length === 0 ? (
          <Text size="sm" tone="muted">
            <Trans>Nothing has changed since {when}.</Trans>
          </Text>
        ) : null}
        {read.state === "ready" && read.changes.length > 0 ? (
          <>
            <ItemGroup aria-label={t`Changes since ${when}`} separated>
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
            </ItemGroup>
            {read.next === null ? null : (
              <Button
                disabled={more}
                layout={styles.start}
                onClick={() => {
                  if (read.next !== null) {
                    void showMore(read.since, read.changes, read.next);
                  }
                }}
                size="sm"
              >
                <Trans>Show more</Trans>
              </Button>
            )}
          </>
        ) : null}
      </div>
    </SectionCard>
  );
};
