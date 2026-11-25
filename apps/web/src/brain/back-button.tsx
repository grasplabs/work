import { Button } from "@grasp-os/ui/components/button";
import { ArrowLeftIcon, Icon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { useCanGoBack, useRouter } from "@tanstack/react-router";

/**
 * Back to where you came from, as the browser's own back button: from a note to the part of the
 * brain or the folder you opened it in. Left out when the page was opened directly, with nowhere
 * in the app to go back to. From the prototype's `components/back-button.tsx`.
 */
export const BackButton = () => {
  const { t } = useLingui();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  if (!canGoBack) {
    return null;
  }
  return (
    <Button
      onClick={() => {
        router.history.back();
      }}
      size="sm"
      variant="ghost"
    >
      <Icon icon={ArrowLeftIcon} />
      {t`Back`}
    </Button>
  );
};
