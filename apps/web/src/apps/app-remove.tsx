import type { App } from "@grasp-os/shared/apps";
import { failureText } from "@grasp-os/shared/errors";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import { Icon, TrashIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useCore } from "../use-core.ts";

// Deleting an archived App (`apps.remove`), on its bar: for its owner or
// an admin of the organization, never Grasp staff, and only once it is
// archived, as core checks. Its stores and their records stay, and so do
// the workflows it doesn't own; its grants, members and bindings end, and
// it is gone from then on, so it asks first and then leaves for Apps.

/** Whether `identity` may delete `app`: archived, and theirs or an admin's. */
const removesApp = (
  app: Pick<App, "archived" | "owner">,
  identity: Pick<Identity, "userId" | "role" | "staff">
): boolean =>
  app.archived &&
  !identity.staff &&
  (app.owner === identity.userId || isAdmin(identity.role));

export const RemoveApp = ({
  app,
  identity,
}: {
  app: App;
  identity: Pick<Identity, "userId" | "role" | "staff">;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const navigate = useNavigate();
  const [failure, setFailure] = useState<string>();
  const { name } = app;
  if (!removesApp(app, identity)) {
    return null;
  }
  const remove = async (): Promise<void> => {
    setFailure(undefined);
    try {
      await core.withSession(async (session) => {
        await session.apps.remove(app.id);
      });
    } catch (error) {
      setFailure(failureText(error));
      throw error;
    }
    await navigate({ to: "/apps", replace: true });
  };
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive">
          <Icon icon={TrashIcon} />
          {t`Delete`}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Delete ${name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`It is gone for good: its pages, versions and members, and what it was allowed. Its stores and their records stay, and so do what its code remembered in the Brain and the workflows it doesn’t own.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failure === undefined ? null : (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel />
          <Button
            errorText={t`Could not delete`}
            loadingText={t`Deleting`}
            onClick={remove}
            variant="destructive"
          >
            {t`Delete for good`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
