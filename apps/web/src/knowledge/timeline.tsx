import type { DocumentRead, VersionSummary } from "@grasp-os/shared/knowledge";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { RouterLink } from "../frame/router-link.tsx";
import { Button } from "../grasp/button/index.ts";
import { ChevronDown, ChevronRight } from "../grasp/icons/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { splitHistory } from "./history.ts";

// A document's history as the prototype's note timeline
// (grasplabs/prototype `routes/brain/$noteId.tsx`): each version on a line
// down the side, with when, who saved it and what changed, the latest five
// shown and older ones folded by month. Each opens for reading; where the
// person may change the document, an earlier one can be restored, saved
// again as the next.

const styles = stylex.create({
  section: { display: "flex", flexDirection: "column", gap: grasp.space4 },
  heading: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: grasp.space3,
    margin: 0,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyleType: "none",
  },
  version: { display: "flex", gap: grasp.space3 },
  when: { flexShrink: 0, width: grasp.space24 },
  // The line down the side, marked where the version shown stands.
  entry: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    gap: grasp.space1,
    minWidth: 0,
    paddingBlockEnd: grasp.space3,
    paddingInlineStart: grasp.space3,
    borderInlineStartWidth: grasp.tabLineWidth,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: grasp.line,
  },
  shown: { borderInlineStartColor: grasp.ink },
  title: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space2,
  },
  month: { marginBlockEnd: grasp.space2 },
  unfold: { alignSelf: "flex-start", marginBlockEnd: grasp.space2 },
});

/**
 * One version on the timeline: it opens for reading, and an earlier one
 * can be restored.
 */
const Saved = ({
  doc,
  version,
  me,
  restore,
}: {
  doc: DocumentRead;
  version: VersionSummary;
  me: string;
  /** Restores it, where the person may; undefined where they may not. */
  restore: ((version: number) => void) | undefined;
}) => {
  const current = version.number === doc.currentVersion;
  const shown = version.number === doc.version.number;
  const { t, i18n } = useLingui();
  const { number, restoredFrom } = version;
  const when = new Date(version.createdAt).toLocaleDateString(i18n.locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const who = version.author === me ? t`You` : version.author;
  return (
    <li aria-label={t`Version ${number}`} {...stylex.props(styles.version)}>
      <Text element="span" layout={styles.when} size="xs" tone="muted">
        <time dateTime={version.createdAt}>{when}</time>
      </Text>
      <div {...stylex.props(styles.entry, shown && styles.shown)}>
        <span {...stylex.props(styles.title)}>
          <RouterLink
            aria-current={shown ? "page" : undefined}
            params={{ collection: doc.collectionId }}
            search={
              current ? { doc: doc.id } : { doc: doc.id, version: number }
            }
            to="/knowledge/$collection"
            variant="standalone"
          >
            {current ? t`Version ${number}, current` : t`Version ${number}`}
          </RouterLink>
          {restore === undefined || current ? null : (
            <Button
              aria-label={t`Restore version ${number}`}
              onClick={() => {
                restore(number);
              }}
              size="xs"
              variant="ghost"
            >
              <Trans>Restore</Trans>
            </Button>
          )}
        </span>
        <Text element="span" size="xs" tone="muted">
          {[
            who,
            restoredFrom === null
              ? version.message
              : t`Restored version ${restoredFrom}`,
          ]
            .filter((part) => part !== null && part !== "")
            .join(" · ")}
        </Text>
      </div>
    </li>
  );
};

/** The timeline of the document's versions. */
export const Timeline = ({
  doc,
  versions,
  me,
  writable,
}: {
  doc: DocumentRead;
  versions: VersionSummary[];
  me: string;
  writable: boolean;
}) => {
  const router = useRouter();
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const { i18n } = useLingui();
  const headingId = useId();
  const { earlier, recent } = splitHistory(versions);
  // Unfolded when the version open on the page is among the earlier ones,
  // so the one marked is always in view.
  const [unfolded, setUnfolded] = useState(() =>
    earlier.some((month) =>
      month.versions.some(({ number }) => number === doc.version.number)
    )
  );
  const folded = earlier.reduce((sum, month) => sum + month.versions.length, 0);
  const restore = async (version: number): Promise<void> => {
    await run(async (session) => {
      // Read again whatever the outcome: a restore refused as a conflict
      // means the page shows an old version.
      await changeThenRefresh(
        async () =>
          await session.knowledge.restoreVersion({
            documentId: doc.id,
            version,
            ifVersion: doc.currentVersion,
          }),
        async () => {
          // The restored text is the current version now: show it.
          await navigate({
            to: "/knowledge/$collection",
            params: { collection: doc.collectionId },
            search: { doc: doc.id },
          });
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  const canRestore =
    writable && !busy
      ? (version: number) => {
          void restore(version);
        }
      : undefined;
  const count = versions.length;
  return (
    <section aria-labelledby={headingId} {...stylex.props(styles.section)}>
      <h2 id={headingId} {...stylex.props(styles.heading)}>
        <Text element="span" size="sm" tone="muted">
          <Trans>History</Trans>
        </Text>
        <Text element="span" size="sm" tone="muted">
          {plural(count, { one: "# version", other: "# versions" })}
        </Text>
      </h2>
      <ErrorText>{failure}</ErrorText>
      <div>
        {folded === 0 ? null : (
          <Button
            aria-expanded={unfolded}
            icon={unfolded ? ChevronDown : ChevronRight}
            layout={styles.unfold}
            onClick={() => {
              setUnfolded(!unfolded);
            }}
            size="xs"
            variant="ghost"
          >
            {plural(folded, { one: "# earlier", other: "# earlier" })}
          </Button>
        )}
        <ol {...stylex.props(styles.list)}>
          {unfolded
            ? earlier.map((month) => (
                <li key={month.month}>
                  <Text layout={styles.month} size="xs" tone="muted">
                    {new Date(`${month.month}-01T00:00:00Z`).toLocaleDateString(
                      i18n.locale,
                      { month: "short", year: "numeric", timeZone: "UTC" }
                    )}
                  </Text>
                  <ol {...stylex.props(styles.list)}>
                    {month.versions.map((version) => (
                      <Saved
                        doc={doc}
                        key={version.number}
                        me={me}
                        restore={canRestore}
                        version={version}
                      />
                    ))}
                  </ol>
                </li>
              ))
            : null}
          {recent.map((version) => (
            <Saved
              doc={doc}
              key={version.number}
              me={me}
              restore={canRestore}
              version={version}
            />
          ))}
        </ol>
      </div>
    </section>
  );
};
