import { workflowLabel } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResource } from "@grasp-os/shared/workflow-resources";
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
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Icon, TrashIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useHeldDialog } from "./held-dialog.ts";
import { SectionCard } from "./section-card.tsx";

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
  resource: Pick<WorkflowResource, "id" | "name" | "title" | "role">;
  /** Whether the reader is one of the organization's admins. */
  admin: boolean;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { failure, run } = useCoreAction();
  const [release, setRelease] = useState(false);
  const [releaseFailure, setReleaseFailure] = useState<string>();
  const name = workflowLabel(resource);
  const reason = releaseFailure;
  const dialog = useHeldDialog();

  if (resource.role !== "builder") {
    return null;
  }

  const removed = async (): Promise<void> => {
    setReleaseFailure(undefined);
    const deleted = await run(async (session) => {
      await session.workflowResources.delete(resource.id);
      return true;
    });
    if (deleted !== true) {
      // The question stays open, with core's reason in it.
      throw new Error("It wasn't deleted.");
    }
    if (release) {
      // Deleted already: a refused release is said on the page, and the
      // name can be released later in Settings.
      const released = await run(async (session) => {
        await session.workflowResources.releaseName(resource.name);
        return true;
      }, setReleaseFailure);
      if (released !== true) {
        return;
      }
    }
    await router.navigate({ to: "/workflows" });
  };
  const remove = async (): Promise<void> => {
    await dialog.hold(removed);
  };

  return (
    <SectionCard
      actions={
        <AlertDialog onOpenChange={dialog.handleOpenChange} open={dialog.open}>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="destructive">
              <Icon icon={TrashIcon} />
              {t`Delete the workflow`}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t`Delete ${name}?`}</AlertDialogTitle>
              <AlertDialogDescription>
                {t`Nobody can open or start it again. Its versions are kept but never served. This can't be undone.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {admin ? (
              <Field orientation="horizontal">
                <Checkbox
                  checked={release}
                  onCheckedChange={(checked) => {
                    setRelease(checked === true);
                  }}
                />
                <FieldLabel>
                  {t`Also release its name, so a new workflow can take it.`}
                </FieldLabel>
              </Field>
            ) : null}
            <ErrorText>{failure}</ErrorText>
            <AlertDialogFooter>
              <AlertDialogCancel />
              <Button
                errorText={t`Not deleted`}
                onClick={remove}
                size="sm"
                variant="destructive"
              >
                {t`Delete the workflow`}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      }
      info={t`It can be deleted once nothing uses it: no other workflow calls it, no trigger or app starts it, and none of its runs is still going.`}
      title={t`Delete this workflow`}
    >
      {reason === undefined ? null : (
        <ErrorText>
          {t`The workflow is deleted, but its name wasn't released: ${reason}`}
        </ErrorText>
      )}
    </SectionCard>
  );
};
