import { failureText } from "@grasp-os/shared/errors";
import { runFileContentPath } from "@grasp-os/shared/run-files";
import type { RunFileListing } from "@grasp-os/shared/run-files";
import { buttonVariants } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { DownloadIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatBytes } from "../format.ts";
import { useCore } from "../use-core.ts";

// The files an independent workflow's run finished writing, to download
// from its run sheet (`workflowResources.runFiles`). Core lists them only
// to whoever may download them, the run's person and, unless the run is
// restricted, the organization's admins, and checks again as each
// download streams (core's workflows/run-file-downloads.ts); anyone else
// is shown nothing here, as they see nothing of what the run returned.

/** Run `run`'s finished files, read once as it mounts. */
export const RunFiles = ({
  workflow,
  run,
}: {
  workflow: string;
  run: string;
}) => {
  const core = useCore();
  const { t } = useLingui();
  const [files, setFiles] = useState<RunFileListing[] | null>(null);
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    let stopped = false;
    const read = async (): Promise<void> => {
      try {
        const listed = await core.withSession(
          async (session) =>
            await session.workflowResources.runFiles(workflow, run)
        );
        if (!stopped) {
          setFiles(listed);
          setFailure(undefined);
        }
      } catch (error) {
        if (!stopped) {
          setFailure(failureText(error));
        }
      }
    };
    void read();
    return () => {
      stopped = true;
    };
  }, [core, run, workflow]);

  if (failure !== undefined) {
    return <ErrorText>{failure}</ErrorText>;
  }
  if (files === null || files.length === 0) {
    return null;
  }
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-muted-foreground">
        <Trans>Files it wrote</Trans>
      </h3>
      <ul className="flex flex-col divide-y rounded-md border">
        {files.map((file) => {
          const { name } = file;
          return (
            <li
              className="flex items-center justify-between gap-3 px-3 py-2"
              key={file.id}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{name}</span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {formatBytes(file.size)}
                </span>
              </span>
              <a
                aria-label={t`Download ${name}`}
                className={buttonVariants({ size: "sm", variant: "outline" })}
                download
                href={runFileContentPath(workflow, run, file.id)}
              >
                <DownloadIcon aria-hidden="true" />
                <Trans context="download a file">Download</Trans>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
