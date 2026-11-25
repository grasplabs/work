import { expectedMessageOf } from "@grasp-os/shared/errors";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import { Snippet } from "@grasp-os/ui/components/snippet";
import { Icon, RefreshCwIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import type { AnyRouter } from "@tanstack/react-router";

import { splitReference } from "../frame/page-states.tsx";
import { notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

// How a part of an Integrations page says it didn't load, as #2503's frame
// says it for every part (its `frame/part-failed.tsx`, which `main`'s frame
// doesn't have yet): a destructive Alert with core's sentence, the
// reference to quote to support as words to copy (never a raw ID in the
// sentence), and Try again. A whole page that didn't load is the frame's
// (PageNotLoaded); this is for a section or a list inside a page that did,
// so what did load stays.

const styles = stylex.create({
  part: {
    display: "grid",
    justifyItems: "start",
    gap: space["3"],
  },
  reference: { width: "min(100%, 18rem)" },
});

/**
 * Why a part of a page did not load: core's reason, its reference to copy,
 * and Try again, which reads the page again. Nothing once it has its data.
 */
export const PartNotLoaded = ({
  page,
  what,
}: {
  page: Loaded<unknown>;
  /** What didn't load, as the Alert's title, where the place doesn't say it ("Used by"). */
  what?: string;
}) => {
  const { t, i18n } = useLingui();
  // Read as what it may be: a part shown outside the router (a test) has none.
  const router: AnyRouter | null = useRouter({ warn: false });
  const reason = notLoadedText(page, i18n);
  if (page.state === "ready" || reason === undefined) {
    return null;
  }
  const split = splitReference(reason);
  const { reference } = split;
  // Only words that tell the reader something: never a bare "it failed".
  const words = split.sentence.trim();
  const bare =
    words === "" ||
    words === expectedMessageOf("internal.unexpected") ||
    words === t`Something went wrong.`;
  const sentence = bare ? undefined : words;
  const title =
    what ?? (sentence === undefined ? t`This didn't load` : undefined);
  return (
    <div data-slot="part-failed" {...stylex.props(styles.part)}>
      <Alert variant="destructive">
        {title === undefined ? null : <AlertTitle>{title}</AlertTitle>}
        {sentence === undefined ? null : (
          <AlertDescription>{sentence}</AlertDescription>
        )}
      </Alert>
      {reference === undefined ? null : (
        <Snippet
          aria-label={t`Reference for support`}
          size="sm"
          style={styles.reference}
          value={reference}
        />
      )}
      {router === null ? null : (
        <Button
          onClick={async () => {
            await router.invalidate();
          }}
          size="sm"
          variant="outline"
        >
          <Icon icon={RefreshCwIcon} />
          {t`Try again`}
        </Button>
      )}
    </div>
  );
};
