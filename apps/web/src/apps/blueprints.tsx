import { failureText } from "@grasp-os/shared/errors";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { Alert } from "../grasp/alert/index.ts";
import { Button, useAction } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import { FloorPlan, Tick } from "../grasp/icons/index.ts";
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
    { working: t`Saving`, done: t`Saved`, failed: t`Could not save` }
  );
  return (
    <>
      <Button
        icon={FloorPlan}
        onClick={() => {
          setSaved(false);
          setOpen(true);
        }}
      >
        {t`Save as blueprint`}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent closeLabel={t`Close`}>
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
              <Alert tone="danger">{failureText(save.error)}</Alert>
            </DialogBody>
          )}
          <DialogFooter>
            {saved ? (
              <DialogAction icon={Tick} variant="ink">
                {t`Done`}
              </DialogAction>
            ) : (
              <>
                <DialogAction>{t`Cancel`}</DialogAction>
                <Button variant="ink" {...save.props}>
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
