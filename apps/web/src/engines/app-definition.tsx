import type { ViewedApp } from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";
import { Trans } from "@lingui/react/macro";
import { DownloadIcon } from "lucide-react";

import { ErrorText } from "../error-text.tsx";
import { downloadText } from "../export/export-file.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { buildsApp } from "./app-role.ts";

// Exporting a domain's definition from its page: its App's current sealed
// release and the workflow versions it binds, as the portable package core
// builds (`apps.definition`, definition-export.ts), saved as JSON for
// another deployment or `vp run package:definition` to take. Core builds
// it without secrets, audits each export and refuses it to anyone but the
// App's builders, Grasp staff among them; a page offers it to them alone,
// and only once a version is current, as there is nothing to export before.

const nonSlug = /[^a-z0-9]+/gu;
const slugEnds = /^-|-$/gu;

/** The file a definition package is saved as: "invoices-v3.json". */
const fileName = (name: string, version: number): string => {
  const slug = name
    .toLowerCase()
    .replaceAll(nonSlug, "-")
    .replaceAll(slugEnds, "");
  return `${slug === "" ? "domain" : slug}-v${version}.json`;
};

/** Whether `identity` may export `app`'s definition. */
export const exportsDefinition = (
  app: Pick<ViewedApp, "role" | "currentVersion">,
  identity: Pick<Identity, "staff">
): boolean => buildsApp(app, identity) && app.currentVersion !== null;

/** Saves the domain's definition package, for its builders. */
export const ExportDefinition = ({
  app,
  identity,
}: {
  app: ViewedApp;
  identity: Pick<Identity, "staff">;
}) => {
  const { busy, failure, run } = useCoreAction();
  if (!exportsDefinition(app, identity)) {
    return null;
  }
  const save = async (): Promise<void> => {
    const definition = await run(
      async (session) => await session.apps.definition(app.id)
    );
    if (definition !== undefined) {
      downloadText(
        fileName(app.name, definition.app.version),
        JSON.stringify(definition, null, 2),
        "application/json"
      );
    }
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        disabled={busy}
        onClick={() => {
          void save();
        }}
        size="sm"
        variant="outline"
      >
        <DownloadIcon data-icon="inline-start" />
        <Trans>Export definition</Trans>
      </Button>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};
