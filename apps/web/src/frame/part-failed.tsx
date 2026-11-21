import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import type { AnyRouter } from "@tanstack/react-router";

import { Alert } from "../grasp/alert/index.ts";
import { Button, useAction } from "../grasp/button/index.ts";
import { CopyField } from "../grasp/copy-field/index.ts";
import { Retry } from "../grasp/icons/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { splitReference, useUseful } from "./page-failed.tsx";

// How a part of a page says it didn't load, the same everywhere: the
// library's Alert in the danger tone with core's sentence, the reference
// to quote to support as a field to copy (never a raw ID in the words),
// and Try again. A whole page that didn't load is the failed page
// (frame/page-states.tsx, PageNotLoaded), which takes the card; this is
// for a section, a panel or a list inside a page that did.

const styles = stylex.create({
  part: {
    display: "grid",
    justifyItems: "start",
    gap: grasp.space3,
  },
  reference: { width: "min(100%, 18rem)" },
});

/**
 * Why a part of a page did not load: core's reason, its reference to copy,
 * and Try again, which reads the page again, or what the part reads itself
 * (`onRetry`). Nothing once it has its data.
 */
export const PartNotLoaded = ({
  page,
  what,
  onRetry,
}: {
  page: Loaded<unknown>;
  /** What didn't load, as the Alert's title, where the place doesn't say it ("Who holds permissions"). */
  what?: string;
  /** Reads it again; the page's own read when left out. */
  onRetry?: () => Promise<void> | void;
}) => {
  const { t, i18n } = useLingui();
  // Read as what it may be: a part shown outside the router (a test) has none.
  const router: AnyRouter | null = useRouter({ warn: false });
  const useful = useUseful();
  const again = useAction(
    async () => {
      if (onRetry !== undefined) {
        await onRetry();
        return;
      }
      await router?.invalidate();
    },
    { working: t`Trying again…`, done: t`Loaded`, failed: t`Not loaded` }
  );
  const reason = notLoadedText(page, i18n);
  if (page.state === "ready" || reason === undefined) {
    return null;
  }
  const split = splitReference(reason);
  const { reference } = split;
  // Only words that tell the reader something: never a bare "it failed".
  const sentence = useful(split.sentence);
  const canRetry = onRetry !== undefined || router !== null;
  return (
    <div data-slot="part-failed" {...stylex.props(styles.part)}>
      <Alert
        title={
          what ?? (sentence === undefined ? t`This didn't load` : undefined)
        }
        tone="danger"
      >
        {sentence}
      </Alert>
      {reference === undefined ? null : (
        <CopyField
          aria-label={t`Reference for support`}
          layout={styles.reference}
          size="sm"
          value={reference}
          words={{ copied: t`Copied`, failed: t`Not copied` }}
        />
      )}
      {canRetry ? (
        <Button icon={Retry} size="sm" {...again.props}>
          {t`Try again`}
        </Button>
      ) : null}
    </div>
  );
};
