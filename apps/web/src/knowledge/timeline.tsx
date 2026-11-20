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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemTitle,
} from "../grasp/item/index.ts";
import { Section, SectionHeader } from "../grasp/section-header/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { splitHistory } from "./history.ts";

// A document's history: each version a row of Grasp UI's Item, the one on
// the page marked current, with when, who saved it and what changed, the latest five
// shown and older ones folded by month. Each opens for reading; where the
// person may change the document, an earlier one can be restored, saved
// again as the next.

const styles = stylex.create({
  earlier: { display: "flex", flexDirection: "column", gap: grasp.space2 },
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
  // A person's own saves are "You"; another author can't be named here
  // yet (core gives an id), and an id is never shown: then only what changed.
  const who = version.author === me ? t`You` : null;
  const said = [
    who,
    restoredFrom === null
      ? version.message
      : t`Restored version ${restoredFrom}`,
  ]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
  return (
    // The version shown on the page is the list's current one.
    <Item current={shown} size="sm">
      <ItemContent>
        <ItemTitle>
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
          <ItemDetail>
            <time dateTime={version.createdAt}>{when}</time>
          </ItemDetail>
        </ItemTitle>
        <ItemDescription>{said}</ItemDescription>
      </ItemContent>
      {restore === undefined || current ? null : (
        <ItemActions>
          <Button
            aria-label={t`Restore version ${number}`}
            onClick={() => {
              restore(number);
            }}
            size="sm"
            variant="ghost"
          >
            <Trans>Restore</Trans>
          </Button>
        </ItemActions>
      )}
    </Item>
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
    <Section aria-labelledby={headingId}>
      <SectionHeader
        actions={
          folded === 0 ? undefined : (
            <Button
              aria-expanded={unfolded}
              icon={unfolded ? ChevronDown : ChevronRight}
              onClick={() => {
                setUnfolded(!unfolded);
              }}
              size="sm"
              variant="ghost"
            >
              {plural(folded, { one: "# earlier", other: "# earlier" })}
            </Button>
          )
        }
        aside={
          <Text element="span" size="sm" tone="muted">
            {plural(count, { one: "# version", other: "# versions" })}
          </Text>
        }
        id={headingId}
        title={<Trans>History</Trans>}
      />
      <ErrorText>{failure}</ErrorText>
      {unfolded
        ? earlier.map((month) => {
            const label = new Date(
              `${month.month}-01T00:00:00Z`
            ).toLocaleDateString(i18n.locale, {
              month: "short",
              year: "numeric",
              timeZone: "UTC",
            });
            return (
              <div key={month.month} {...stylex.props(styles.earlier)}>
                <Text size="xs" tone="muted">
                  {label}
                </Text>
                <ItemGroup aria-label={label} separated>
                  {month.versions.map((version) => (
                    <Saved
                      doc={doc}
                      key={version.number}
                      me={me}
                      restore={canRestore}
                      version={version}
                    />
                  ))}
                </ItemGroup>
              </div>
            );
          })
        : null}
      <ItemGroup separated>
        {recent.map((version) => (
          <Saved
            doc={doc}
            key={version.number}
            me={me}
            restore={canRestore}
            version={version}
          />
        ))}
      </ItemGroup>
    </Section>
  );
};
