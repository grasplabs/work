import type { WorkflowResource } from "@grasp-os/shared/workflow-resources";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Checkbox } from "../grasp/checkbox/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { Trash } from "../grasp/icons/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
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
  const router = useRouter();
  const { failure, run } = useCoreAction();
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
      // The question stays open, with core's reason in it.
      throw new Error("It wasn't deleted.");
    }
    if (release) {
      // Deleted already: a refused release is said on the page, and the
      // name can be released later in Settings.
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
    <SectionCard
      actions={
        <AlertDialog>
          <AlertDialogTrigger icon={Trash} size="sm" variant="danger">
            {t`Delete the workflow`}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>{t`Delete ${name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`Nobody can open or start it again. Its versions are kept but never served. This can't be undone.`}
            </AlertDialogDescription>
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
              <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
              <AlertDialogAction
                action={remove}
                failedLabel={t`Not deleted`}
                variant="danger"
              >
                {t`Delete the workflow`}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      }
      density="compact"
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
