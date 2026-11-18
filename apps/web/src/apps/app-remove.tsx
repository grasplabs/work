import type { App } from "@grasp-os/shared/apps";
import { failureText } from "@grasp-os/shared/errors";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Trash } from "../grasp/icons/index.ts";
import { useCore } from "../use-core.ts";

// Deleting an archived App (`apps.remove`), on its bar: for its owner or
// an admin of the organization, never Grasp staff, and only once it is
// archived, as core checks. Its stores and their records stay, and so do
// the workflows it doesn't own; its grants, members and bindings end, and
// it is gone from then on, so it asks first and then leaves for Apps.

/** Whether `identity` may delete `app`: archived, and theirs or an admin's. */
export const removesApp = (
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
      <AlertDialogTrigger icon={Trash} variant="danger">
        {t`Delete`}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>{t`Delete ${name}?`}</AlertDialogTitle>
        <AlertDialogDescription>
          {t`It is gone for good: its pages, versions and members, and what it was allowed. Its stores and their records stay, and so do the workflows it doesn’t own.`}
        </AlertDialogDescription>
        {failure === undefined ? null : <Alert tone="danger">{failure}</Alert>}
        <AlertDialogFooter>
          <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
          <AlertDialogAction
            action={remove}
            failedLabel={t`Could not delete`}
            variant="danger"
            workingLabel={t`Deleting`}
          >
            {t`Delete for good`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
