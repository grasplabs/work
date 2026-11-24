import type {
  WorkflowResourceVersion,
  WorkflowVersionSource,
} from "@grasp-os/shared/workflow-resources";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { DownloadIcon, FileIcon, Icon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { Code } from "./code.tsx";
import { SectionCard } from "./section-card.tsx";
import { SeparatedItems } from "./separated-items.tsx";

// Any published version of an independent workflow, as its builders read
// it (GRA-1329), by its label: its definition exactly as published
// (`versions.files`, its one file `workflow.json`), and its portable source, the
// definition and the code generated from it read back from what was
// sealed (`workflowResources.source`), each file to download. Core gives
// both to the workflow's builders alone; nothing here changes a version.

const styles = stylex.create({
  body: { display: "flex", flexDirection: "column", gap: space["4"] },
  pick: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
});

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
  const { busy, failure, run } = useCoreAction();
  const published =
    versions.state === "ready"
      ? versions.data.toSorted((a, b) => a.version - b.version)
      : [];
  const [chosen, setChosen] = useState(published.at(-1)?.version);
  const [shown, setShown] = useState<{ version: number; text: string }>();
  const [source, setSource] = useState<{
    version: number;
    files: WorkflowVersionSource["files"];
  }>();
  /** What people call version `version`: as everywhere else on its page. */
  const nameOf = (version: number): string => t`v${version}`;

  if (!builder || chosen === undefined) {
    return null;
  }

  const show = async (): Promise<void> => {
    const files = await run(
      async (session) =>
        await session.versions.files({ kind: "workflow", id: workflow }, chosen)
    );
    const text = files?.["workflow.json"];
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

  const shownVersion = shown === undefined ? "" : nameOf(shown.version);
  const sourceVersion = source === undefined ? "" : nameOf(source.version);
  return (
    <SectionCard title={t`A version's definition and source`}>
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.pick)}>
          <Select
            items={published.map(({ version }) => ({
              value: String(version),
              label: nameOf(version),
            }))}
            onValueChange={(value) => {
              if (value !== null) {
                setChosen(Number(value));
              }
            }}
            value={String(chosen)}
          >
            <SelectTrigger aria-label={t`Version`} size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent />
          </Select>
          <Button
            disabled={busy}
            onClick={() => {
              void show();
            }}
            size="sm"
            variant="outline"
          >
            {t`Show its definition`}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              void readSource();
            }}
            size="sm"
            variant="outline"
          >
            {t`Its source files`}
          </Button>
        </div>
        {failure === undefined ? null : (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        {shown === undefined ? null : (
          <Code
            code={shown.text}
            language="json"
            languageLabel={t`The definition of version ${shownVersion}`}
          />
        )}
        {source === undefined ? null : (
          <SeparatedItems
            aria-label={t`The source files of version ${sourceVersion}`}

            rows={Object.entries(source.files).map(([path, text]) => ({
              key: path,
              row: (
                <Item size="xs">
                  <ItemMedia>
                    <Icon icon={FileIcon} />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>
                      <code>{path}</code>
                    </ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      aria-label={t`Download ${path}`}
                      onClick={() => {
                        save(path, text);
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      <Icon icon={DownloadIcon} />
                      {t({ message: "Download", context: "download a file" })}
                    </Button>
                  </ItemActions>
                </Item>
              ),
            }))}
          />
        )}
      </div>
    </SectionCard>
  );
};
