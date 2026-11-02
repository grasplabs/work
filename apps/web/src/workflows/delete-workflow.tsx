import type { WorkflowResource } from "@grasp-os/shared/workflow-resources";
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
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import { Label } from "@grasp-os/ui/components/label";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Deleting an independent workflow (GRA-1329), for its builders, asked
// first: core deletes it only while nothing holds it (another workflow's
// current version calling it, a trigger or an App binding able to start
// it, a run not yet ended) and says what does otherwise
// (`workflowResources.delete`). Its versions stay, never served again,
// and its name stays taken. One of the organization's admins may also
// release the name as it goes, so a new workflow may take it
// (`workflowResources.releaseName`), which core refuses while anything
// still names one of its versions. Grasp staff do neither: core refuses
// them, and says so.

/** Delete, for workflow `resource`'s builders; release its name too, for `admin`s. */
export const DeleteWorkflow = ({
  resource,
  admin,
}: {
  resource: Pick<WorkflowResource, "id" | "name" | "role">;
  /** Whether the reader is one of the organization's admins. */
  admin: boolean;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [release, setRelease] = useState(false);
  const [releaseFailure, setReleaseFailure] = useState<string>();
  const { name } = resource;
  const reason = releaseFailure;

  if (resource.role !== "builder") {
    return null;
  }

  const remove = async (): Promise<void> => {
    setReleaseFailure(undefined);
    const deleted = await run(async (session) => {
      await session.workflowResources.delete(resource.id);
      return true;
    });
    if (deleted !== true) {
      return;
    }
    if (release) {
      // Deleted already: a refused release is said here, and the name can
      // be released later in Settings.
      const released = await run(async (session) => {
        await session.workflowResources.releaseName(name);
        return true;
      }, setReleaseFailure);
      if (released !== true) {
        return;
      }
    }
    await router.navigate({ to: "/workflows" });
  };

  return (
    <section className="mt-8 flex flex-col gap-3 border-t pt-6">
      <h2 className="font-medium">
        <Trans>Delete this workflow</Trans>
      </h2>
      <p className="text-muted-foreground">
        <Trans>
          It can be deleted once nothing uses it: no other workflow calls it, no
          trigger or app starts it, and none of its runs is still going.
        </Trans>
      </p>
      <div>
        <AlertDialog>
          <AlertDialogTrigger
            disabled={busy}
            render={<Button size="sm" variant="outline" />}
          >
            <Trans>Delete the workflow</Trans>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>Delete {name}?</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription>
                <Trans>
                  Nobody can open or start it again. Its versions are kept but
                  never served. This can&apos;t be undone.
                </Trans>
              </AlertDialogDescription>
            </AlertDialogHeader>
            {admin ? (
              <div className="flex items-start gap-2">
                <Checkbox
                  checked={release}
                  id={`${ids}-release`}
                  onCheckedChange={(checked) => {
                    setRelease(checked);
                  }}
                />
                <Label htmlFor={`${ids}-release`}>
                  <Trans>
                    Also release its name, so a new workflow can take it.
                  </Trans>
                </Label>
              </div>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel>
                <Trans>Cancel</Trans>
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                onClick={() => {
                  void remove();
                }}
                variant="destructive"
              >
                {t`Delete the workflow`}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <ErrorText>{failure}</ErrorText>
      {reason === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          <Trans>
            The workflow is deleted, but its name wasn&apos;t released: {reason}
          </Trans>
        </p>
      )}
    </section>
  );
};
