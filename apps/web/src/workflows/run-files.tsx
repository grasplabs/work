import { failureText } from "@grasp-os/shared/errors";
import { runFileContentPath } from "@grasp-os/shared/run-files";
import type { RunFileListing } from "@grasp-os/shared/run-files";
import { Button } from "@grasp-os/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { DownloadIcon, FileIcon, Icon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useEffectEvent, Fragment } from "react";
import type { ReactNode } from "react";

import { formatBytes } from "../format.ts";
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
      <ItemMedia>
        <Icon icon={FileIcon} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        <ItemDescription>{formatBytes(file.size)}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button asChild size="xs" variant="ghost">
          <a
            aria-label={t`Download ${name}`}
            download
            href={runFileContentPath(workflow, run, file.id)}
          >
            <Icon icon={DownloadIcon} />
            {t({ message: "Download", context: "download a file" })}
          </a>
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

/** A section of a run's panel: its title, and what it holds. */
export interface RunPanelSection {
  id: string;
  label: string;
  content: ReactNode;
}

/** The panel's section of the files `read` lists; none while there are none. */
export const useRunFilesSection = (
  workflow: string,
  run: string,
  read: RunFilesRead | undefined
): RunPanelSection | undefined => {
  const { t } = useLingui();
  const files = read === undefined ? null : read.files;
  if (files === null || files.length === 0) {
    return undefined;
  }
  return {
    id: "files",
    label: t`Files it wrote`,
    content: (
      <ItemGroup aria-label={t`Files it wrote`}>
        {files.map((file, at) => (
          <Fragment key={file.id}>
            {at === 0 ? null : <ItemSeparator />}
            <FileRow file={file} run={run} workflow={workflow} />
          </Fragment>
        ))}
      </ItemGroup>
    ),
  };
};
