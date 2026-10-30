import type { App } from "@grasp-os/shared/apps";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
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
import { useNavigate } from "@tanstack/react-router";
import { TrashIcon } from "lucide-react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Deleting an archived domain (`apps.remove`), on its bar: for its owner or
// an admin of the organization, never Grasp staff, and only once it is
// archived, as core checks. Its stores and their records stay, and so do
// the workflows it doesn't own; its grants, members and bindings end, and
// it is gone from then on, so it asks first and then leaves for Domains.

/** Whether `identity` may delete `app`: archived, and theirs or an admin's. */
export const removesApp = (
  app: Pick<App, "status" | "owner">,
  identity: Pick<Identity, "userId" | "role" | "staff">
): boolean =>
  app.status === "archived" &&
  !identity.staff &&
  (app.owner === identity.userId || isAdmin(identity.role));

export const RemoveApp = ({
  app,
  identity,
}: {
  app: App;
  identity: Pick<Identity, "userId" | "role" | "staff">;
}) => {
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const { name } = app;
  if (!removesApp(app, identity)) {
    return null;
  }
  const remove = async (): Promise<void> => {
    const done = await run(async (session) => {
      await session.apps.remove(app.id);
      return true;
    });
    if (done === true) {
      await navigate({ to: "/domains", replace: true });
    }
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <AlertDialog>
        <AlertDialogTrigger
          disabled={busy}
          render={<Button size="sm" variant="destructive" />}
        >
          <TrashIcon data-icon="inline-start" />
          <Trans>Delete</Trans>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Delete {name}?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                It is gone for good: its apps, versions and members, and what it
                was allowed. Its stores and their records stay, and so do the
                workflows it doesn’t own.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void remove();
              }}
              variant="destructive"
            >
              <Trans>Delete for good</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};
