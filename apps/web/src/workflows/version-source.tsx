import type {
  WorkflowResourceVersion,
  WorkflowVersionSource,
} from "@grasp-os/shared/workflow-resources";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import { CodeBlock } from "../grasp/code-block/index.ts";
import { Download, File } from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Any published version of an independent workflow, as its builders read
// it (GRA-1329): its definition exactly as published
// (`workflowResources.definition`), and its portable source, the
// definition and the code generated from it read back from what was
// sealed (`workflowResources.source`), each file to download. Core gives
// both to the workflow's builders alone; nothing here changes a version.

const styles = stylex.create({
  body: { display: "flex", flexDirection: "column", gap: grasp.space4 },
  pick: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
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
    <SectionCard density="compact" title={t`A version's definition and source`}>
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.pick)}>
          <Select
            items={published.map((version) => ({
              value: String(version),
              label: t`Version ${version}`,
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
            variant="quiet"
          >
            {t`Show its definition`}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              void readSource();
            }}
            size="sm"
            variant="quiet"
          >
            {t`Its source files`}
          </Button>
        </div>
        {failure === undefined ? null : <Alert tone="danger">{failure}</Alert>}
        {shown === undefined ? null : (
          <CodeBlock
            code={shown.text}
            copyLabel={t`Copy the definition`}
            language="json"
            languageLabel={t`The definition of version ${shownVersion}`}
            lineNumbers={false}
          />
        )}
        {source === undefined ? null : (
          <ItemGroup
            aria-label={t`The source files of version ${sourceVersion}`}
            separated
          >
            {Object.entries(source.files).map(([path, text]) => (
              <Item key={path} size="xs">
                <ItemMedia icon={File} iconLook="inline" />
                <ItemContent>
                  <ItemTitle>
                    <code>{path}</code>
                  </ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    aria-label={t`Download ${path}`}
                    icon={Download}
                    onClick={() => {
                      save(path, text);
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    {t({ message: "Download", context: "download a file" })}
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
      </div>
    </SectionCard>
  );
};
