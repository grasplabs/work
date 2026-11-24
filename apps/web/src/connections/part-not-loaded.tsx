import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import type { AnyRouter } from "@tanstack/react-router";

import { notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

// How a part of an Integrations page says it didn't load: Damsko's Alert
// in the destructive variant with core's sentence, and Try again, which
// reads the page again. A whole page that didn't load is the frame's
// (frame/page-states.tsx, PageNotLoaded); this is for a section or a list
// inside a page that did.

/** Why a part of the page did not load, and Try again; nothing once it has its data. */
export const PartNotLoaded = ({
  page,
  what,
}: {
  page: Loaded<unknown>;
  /** What didn't load, as the Alert's title, where the place doesn't say it ("Which Apps and agents hold permissions"). */
  what?: string;
}) => {
  const { t, i18n } = useLingui();
  // Read as what it may be: a part shown outside the router (a test) has none.
  const router: AnyRouter | null = useRouter({ warn: false });
  const reason = notLoadedText(page, i18n);
  if (page.state === "ready" || reason === undefined) {
    return null;
  }
  return (
    <Alert variant="destructive">
      {what === undefined ? null : <AlertTitle>{what}</AlertTitle>}
      <AlertDescription>{reason}</AlertDescription>
      {router === null ? null : (
        <AlertAction>
          <Button
            errorText={t`Not loaded`}
            loadingText={t`Trying again…`}
            onClick={async () => {
              await router.invalidate();
            }}
            size="xs"
            variant="outline"
          >
            {t`Try again`}
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
};
