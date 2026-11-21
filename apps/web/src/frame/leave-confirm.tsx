import { useLingui } from "@lingui/react/macro";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";

/**
 * Grasp's question before a link out of Grasp opens, the one rule for every
 * link a model or a person wrote (an answer, its thinking, a Brain note):
 * `href` opens in its own tab, without this page as its opener, only once
 * the person says so. Open while `href` is set.
 */
export const LeaveConfirm = ({
  href,
  onClose,
}: {
  href: string | undefined;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  return (
    <AlertDialog
      onOpenChange={(open, { returnValue }) => {
        if (open) {
          return;
        }
        if (returnValue === "open" && href !== undefined) {
          window.open(href, "_blank", "noopener,noreferrer");
        }
        onClose();
      }}
      open={href !== undefined}
    >
      <AlertDialogContent>
        <AlertDialogTitle>{t`Open external link?`}</AlertDialogTitle>
        <AlertDialogDescription>{href}</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <AlertDialogAction value="open" variant="ink">
            {t`Open link`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
