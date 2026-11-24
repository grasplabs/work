import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import { Icon, RefreshCwIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import type { AnyRouter } from "@tanstack/react-router";

import { notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

// How a part of a Brain page says it didn't load, from the reference's
// frame (#2503's `frame/part-failed.tsx`): Damsko's Alert in the danger
// colour with core's sentence, and Try again. A whole page that didn't
// load is the failed page (frame/page-states.tsx, PageNotLoaded); this is
// for a list inside a page that did.

const styles = stylex.create({
  part: {
    display: "grid",
    justifyItems: "start",
    gap: space["3"],
  },
});

/**
 * Why a part of a page did not load: core's reason, and Try again, which
 * reads the page again, or what the part reads itself (`onRetry`). Nothing
 * once it has its data.
 */
export const PartNotLoaded = ({
  page,
  what,
  onRetry,
}: {
  page: Loaded<unknown>;
  /** What didn't load, as the Alert's title, where the place doesn't say it. */
  what?: string;
  /** Reads it again; the page's own read when left out. */
  onRetry?: () => Promise<void> | void;
}) => {
  const { t, i18n } = useLingui();
  // Read as what it may be: a part shown outside the router (a test) has none.
  const router: AnyRouter | null = useRouter({ warn: false });
  const reason = notLoadedText(page, i18n);
  if (page.state === "ready" || reason === undefined) {
    return null;
  }
  const canRetry = onRetry !== undefined || router !== null;
  return (
    <div data-slot="part-failed" {...stylex.props(styles.part)}>
      <Alert variant="destructive">
        {what === undefined ? null : <AlertTitle>{what}</AlertTitle>}
        <AlertDescription>{reason}</AlertDescription>
      </Alert>
      {canRetry ? (
        <Button
          errorText={t`Not loaded`}
          loadingText={t`Trying again…`}
          onClick={async () => {
            await (onRetry === undefined ? router?.invalidate() : onRetry());
          }}
          size="sm"
          successText={t`Loaded`}
          variant="outline"
        >
          <Icon icon={RefreshCwIcon} />
          {t`Try again`}
        </Button>
      ) : null}
    </div>
  );
};
