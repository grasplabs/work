import type {
  WorkflowResourceVersion,
  WorkflowVersionSource,
} from "@grasp-os/shared/workflow-resources";
import { Button } from "@grasp-os/ui/components/button";
import { Label } from "@grasp-os/ui/components/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Trans, useLingui } from "@lingui/react/macro";
import { DownloadIcon } from "lucide-react";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Any published version of an independent workflow, as its builders read
// it (GRA-1329): its definition exactly as published
// (`workflowResources.definition`), and its portable source, the
// definition and the code generated from it read back from what was
// sealed (`workflowResources.source`), each file to download. Core gives
// both to the workflow's builders alone; nothing here changes a version.

/** Saves `text` as a file named after `path`, in the person's downloads. */
const save = (path: string, text: string): void => {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = path.split("/").at(-1) ?? path;
  link.click();
  URL.revokeObjectURL(url);
};

/** A version picked from `versions`, its definition shown and its source to download. */
export const VersionSource = ({
  workflow,
  versions,
  builder,
}: {
  workflow: string;
  /** The published versions, as the page read them. */
  versions: Loaded<WorkflowResourceVersion[]>;
  builder: boolean;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const { busy, failure, run } = useCoreAction();
  const published =
    versions.state === "ready"
      ? versions.data.map(({ version }) => version).toSorted((a, b) => a - b)
      : [];
  const [chosen, setChosen] = useState(published.at(-1));
  const [shown, setShown] = useState<{ version: number; text: string }>();
  const [source, setSource] = useState<{
    version: number;
    files: WorkflowVersionSource["files"];
  }>();

  if (!builder || chosen === undefined) {
    return null;
  }

  const show = async (): Promise<void> => {
    const text = await run(
      async (session) =>
        await session.workflowResources.definition(workflow, chosen)
    );
    if (text !== undefined) {
      setShown({ version: chosen, text });
    }
  };

  const readSource = async (): Promise<void> => {
    const read = await run(
      async (session) =>
        await session.workflowResources.source(workflow, chosen)
    );
    if (read !== undefined) {
      setSource({ version: chosen, files: read.files });
    }
  };

  const shownVersion = shown?.version;
  const sourceVersion = source?.version;
  return (
    <section className="mt-8 flex flex-col gap-3">
      <h2 className="font-medium">
        <Trans>A version&apos;s definition and source</Trans>
      </h2>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-version`}>
            <Trans>Version</Trans>
          </Label>
          <NativeSelect
            id={`${ids}-version`}
            onChange={(event) => {
              setChosen(Number(event.target.value));
            }}
            value={String(chosen)}
          >
            {published.map((version) => (
              <NativeSelectOption key={version} value={String(version)}>
                {t`Version ${version}`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Button
          disabled={busy}
          onClick={() => {
            void show();
          }}
          variant="outline"
        >
          <Trans>Show its definition</Trans>
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            void readSource();
          }}
          variant="outline"
        >
          <Trans>Its source files</Trans>
        </Button>
      </div>
      <ErrorText>{failure}</ErrorText>
      {shown === undefined ? null : (
        <div className="flex flex-col gap-2">
          <h3 className="text-muted-foreground">
            <Trans>The definition of version {shownVersion}</Trans>
          </h3>
          <pre className="bg-muted max-h-96 overflow-auto rounded-md p-3 text-xs">
            {shown.text}
          </pre>
        </div>
      )}
      {source === undefined ? null : (
        <div className="flex flex-col gap-2">
          <h3 className="text-muted-foreground">
            <Trans>The source files of version {sourceVersion}</Trans>
          </h3>
          <ul className="flex flex-col divide-y rounded-md border">
            {Object.entries(source.files).map(([path, text]) => (
              <li
                className="flex items-center justify-between gap-3 px-3 py-2"
                key={path}
              >
                <code className="min-w-0 truncate font-mono text-xs">
                  {path}
                </code>
                <Button
                  aria-label={t`Download ${path}`}
                  onClick={() => {
                    save(path, text);
                  }}
                  size="sm"
                  variant="outline"
                >
                  <DownloadIcon aria-hidden="true" />
                  <Trans context="download a file">Download</Trans>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};
