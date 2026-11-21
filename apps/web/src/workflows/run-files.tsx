import { failureText } from "@grasp-os/shared/errors";
import { runFileContentPath } from "@grasp-os/shared/run-files";
import type { RunFileListing } from "@grasp-os/shared/run-files";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useEffectEvent } from "react";

import { formatBytes } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { Download, File } from "../grasp/icons/index.ts";
import type { InspectorSection } from "../grasp/inspector-panel/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { useCore } from "../use-core.ts";

// The files an independent workflow's run finished writing, to download
// from its panel (`workflowResources.runFiles`). Core lists them only
// to whoever may download them, the run's person and, unless the run is
// restricted, the organization's admins, and checks again as each
// download streams (core's workflows/run-file-downloads.ts); anyone else
// is shown nothing here, as they see nothing of what the run returned.

/** One file, a row with its size and the way to download it. */
const FileRow = ({
  workflow,
  run,
  file,
}: {
  workflow: string;
  run: string;
  file: RunFileListing;
}) => {
  const { t } = useLingui();
  const { name } = file;
  return (
    <Item size="xs">
      <ItemMedia icon={File} iconLook="inline" />
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        <ItemDescription>{formatBytes(file.size)}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          aria-label={t`Download ${name}`}
          icon={Download}
          render={
            // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the Button gives it its name
            <a download href={runFileContentPath(workflow, run, file.id)} />
          }
          size="xs"
          variant="ghost"
        >
          {t({ message: "Download", context: "download a file" })}
        </Button>
      </ItemActions>
    </Item>
  );
};

/** What reading a run's files came to: none yet, the files, or why not. */
export interface RunFilesRead {
  files: RunFileListing[] | null;
  failure: string | undefined;
}

/**
 * Reads run `run`'s finished files once as it mounts, into `onRead`; the
 * panel mounts it again once the run ends, with what it finished last.
 */
export const RunFilesReader = ({
  workflow,
  run,
  onRead,
}: {
  workflow: string;
  run: string;
  onRead: (read: RunFilesRead) => void;
}) => {
  const core = useCore();
  const told = useEffectEvent(onRead);
  useEffect(() => {
    let stopped = false;
    const read = async (): Promise<void> => {
      try {
        const listed = await core.withSession(
          async (session) =>
            await session.workflowResources.runFiles(workflow, run)
        );
        if (!stopped) {
          told({ files: listed, failure: undefined });
        }
      } catch (error) {
        if (!stopped) {
          told({ files: null, failure: failureText(error) });
        }
      }
    };
    void read();
    return () => {
      stopped = true;
    };
  }, [core, run, workflow]);
  return null;
};

/** The panel's section of the files `read` lists; none while there are none. */
export const useRunFilesSection = (
  workflow: string,
  run: string,
  read: RunFilesRead | undefined
): InspectorSection | undefined => {
  const { t } = useLingui();
  const files = read === undefined ? null : read.files;
  if (files === null || files.length === 0) {
    return undefined;
  }
  return {
    id: "files",
    label: t`Files it wrote`,
    content: (
      <ItemGroup aria-label={t`Files it wrote`} separated>
        {files.map((file) => (
          <FileRow file={file} key={file.id} run={run} workflow={workflow} />
        ))}
      </ItemGroup>
    ),
  };
};
