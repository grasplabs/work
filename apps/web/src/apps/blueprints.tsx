import { failureText } from "@grasp-os/shared/errors";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { useAction } from "@grasp-os/ui/hooks/use-action";
import { CheckIcon, FloorPlanIcon, Icon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { useCore } from "../use-core.ts";

// Blueprints, as in the prototype (grasplabs/prototype
// `blueprint-dialog.tsx`): a version of an App saved for Grasp's agent to
// start new Apps from (`env.build.createFromBlueprint`). Core names a
// blueprint after its App as it was saved, so saving asks for no name.

/**
 * Save as blueprint: marks the App's current version as a blueprint,
 * under the App's own name and description. The App stays as it is.
 */
export const SaveAsBlueprint = ({
  app,
  name,
  version,
}: {
  app: string;
  name: string;
  version: number;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = useAction(
    async () => {
      await core.withSession(
        async (session) => await session.apps.blueprints.mark(app, version)
      );
      setSaved(true);
    },
    {
      loadingLabel: t`Saving`,
      successLabel: t`Saved`,
      errorLabel: t`Could not save`,
    }
  );
  return (
    <>
      <Button
        onClick={() => {
          setSaved(false);
          setOpen(true);
        }}
        variant="secondary"
      >
        <Icon icon={FloorPlanIcon} />
        {t`Save as blueprint`}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogTitle>
            {saved ? t`Saved as a blueprint` : t`Save ${name} as a blueprint`}
          </DialogTitle>
          <DialogDescription>
            {saved
              ? t`Anyone who builds and has a role in ${name} can now start a new app from it. ${name} itself stays as it is.`
              : t`New Apps can start from version ${version} of ${name}, as a copy with none of its data. ${name} itself stays as it is.`}
          </DialogDescription>
          {save.error === undefined || saved ? null : (
            <DialogBody>
              <Alert variant="destructive">
                <AlertDescription>{failureText(save.error)}</AlertDescription>
              </Alert>
            </DialogBody>
          )}
          <DialogFooter>
            {saved ? (
              <DialogClose variant="default">
                <Icon icon={CheckIcon} />
                {t`Done`}
              </DialogClose>
            ) : (
              <>
                <DialogClose>{t`Cancel`}</DialogClose>
                <Button
                  variant="default"
                  errorLabel={save.labels.error}
                  loadingLabel={save.labels.loading}
                  onClick={() => {
                    void save.run();
                  }}
                  status={save.status}
                  successLabel={save.labels.success}
                >
                  {t`Save as blueprint`}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
