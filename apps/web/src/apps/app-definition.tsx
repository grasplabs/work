import type { ViewedApp } from "@grasp-os/shared/apps";
import { failureText } from "@grasp-os/shared/errors";
import type { Identity } from "@grasp-os/shared/rpc";
import { useLingui } from "@lingui/react/macro";

import { downloadText } from "../export/export-file.tsx";
import { Alert } from "../grasp/alert/index.ts";
import { Button, useAction } from "../grasp/button/index.ts";
import { Download } from "../grasp/icons/index.ts";
import { useCore } from "../use-core.ts";
import { buildsApp } from "./app-role.ts";

// Exporting an App's definition from its page: its App's current sealed
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
  return `${slug === "" ? "App" : slug}-v${version}.json`;
};

/** Whether `identity` may export `app`'s definition. */
export const exportsDefinition = (
  app: Pick<ViewedApp, "role" | "currentVersion">,
  identity: Pick<Identity, "staff">
): boolean => buildsApp(app, identity) && app.currentVersion !== null;

/** Saves the App's definition package, for its builders. */
export const ExportDefinition = ({
  app,
  identity,
}: {
  app: ViewedApp;
  identity: Pick<Identity, "staff">;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const save = useAction(
    async () => {
      const definition = await core.withSession(
        async (session) => await session.apps.definition(app.id)
      );
      downloadText(
        fileName(app.name, definition.app.version),
        JSON.stringify(definition, null, 2),
        "application/json"
      );
    },
    { working: t`Exporting`, done: t`Exported`, failed: t`Could not export` }
  );
  if (!exportsDefinition(app, identity)) {
    return null;
  }
  // The error goes under the buttons of the card it sits in: a whole line
  // of their row.
  return (
    <>
      <Button icon={Download} {...save.props}>
        {t`Export definition`}
      </Button>
      {save.error === undefined ? null : (
        <Alert tone="danger">{failureText(save.error)}</Alert>
      )}
    </>
  );
};
