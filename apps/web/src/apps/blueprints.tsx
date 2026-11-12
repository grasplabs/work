import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Trans, useLingui } from "@lingui/react/macro";
import { CheckIcon, LayoutTemplateIcon } from "lucide-react";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

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
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = async (): Promise<void> => {
    const marked = await run(
      async (session) => await session.apps.blueprints.mark(app, version)
    );
    if (marked !== undefined) {
      setSaved(true);
    }
  };
  return (
    <>
      <Button
        onClick={() => {
          setSaved(false);
          setOpen(true);
        }}
        size="sm"
        variant="outline"
      >
        <LayoutTemplateIcon data-icon="inline-start" />
        <Trans>Save as blueprint</Trans>
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="sm:max-w-md" closeLabel={t`Close`}>
          <DialogHeader>
            <DialogTitle>
              {saved ? (
                <Trans>Saved as a blueprint</Trans>
              ) : (
                <Trans>Save {name} as a blueprint</Trans>
              )}
            </DialogTitle>
            <DialogDescription>
              {saved ? (
                <Trans>
                  Anyone who builds and has a role in {name} can now start a new
                  app from it. {name} itself stays as it is.
                </Trans>
              ) : (
                <Trans>
                  New Apps can start from version {version} of {name}, as a copy
                  with none of its data. {name} itself stays as it is.
                </Trans>
              )}
            </DialogDescription>
          </DialogHeader>
          <ErrorText>{failure}</ErrorText>
          <DialogFooter>
            {saved ? (
              <>
                <CheckIcon
                  aria-hidden="true"
                  className="text-status-agreed size-4 self-center"
                />
                <Button
                  onClick={() => {
                    setOpen(false);
                  }}
                >
                  <Trans>Done</Trans>
                </Button>
              </>
            ) : (
              <>
                <Button
                  onClick={() => {
                    setOpen(false);
                  }}
                  variant="ghost"
                >
                  <Trans>Cancel</Trans>
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    void save();
                  }}
                >
                  <Trans>Save as blueprint</Trans>
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
