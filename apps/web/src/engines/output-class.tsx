import type {
  OutputClass,
  ScreenTrustReview,
} from "@grasp-os/shared/screen-trust";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import { Trans } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Whether a domain's data is sensitive or ordinary to its apps, on its
// Approval section, which only the organization's own admins see
// (`screenTrust.classify`, never Grasp staff, as core checks). Sensitive,
// as every domain's is until an admin says otherwise, its apps get its
// data only once an admin approved their exact code; ordinary, its apps
// get it whether or not anyone approved them. Saying it is ordinary is the
// weaker setting, so it asks first and says what it gives up. Core takes
// it only under the policy generation the admin reviewed, so a decision
// made meanwhile is refused rather than overruled, and a permission
// granted later makes the data sensitive again.

/** Marking the domain's data the other way, once confirmed. */
export const OutputClassControl = ({
  review,
}: {
  review: Pick<ScreenTrustReview, "app" | "output" | "generation">;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const ordinary = review.output === "ordinary";
  const next: OutputClass = ordinary ? "sensitive" : "ordinary";
  const classify = async (): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () =>
          await session.screenTrust.classify(
            review.app,
            next,
            review.generation
          ),
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <div className="flex flex-col items-start gap-1">
      <AlertDialog>
        <AlertDialogTrigger
          disabled={busy}
          render={<Button size="sm" variant="outline" />}
        >
          {ordinary ? (
            <Trans>Mark its data sensitive</Trans>
          ) : (
            <Trans>Mark its data ordinary</Trans>
          )}
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {ordinary ? (
                <Trans>Mark this domain’s data sensitive?</Trans>
              ) : (
                <Trans>Mark this domain’s data ordinary?</Trans>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {ordinary ? (
                <Trans>
                  Its apps get its data again only once an admin approved
                  exactly their code. Apps nobody approved stop getting it from
                  their next call.
                </Trans>
              ) : (
                <Trans>
                  Its apps get its data whether or not anyone approved their
                  code, so code nobody read can send it elsewhere. A permission
                  granted to this domain later makes its data sensitive again.
                </Trans>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void classify();
              }}
              variant={ordinary ? "default" : "destructive"}
            >
              {ordinary ? (
                <Trans>Mark sensitive</Trans>
              ) : (
                <Trans>Mark ordinary</Trans>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};
