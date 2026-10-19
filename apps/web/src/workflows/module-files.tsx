import {
  workflowModuleLimits,
  workflowModulePattern,
} from "@grasp-os/shared/workflow-modules";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { Label } from "@grasp-os/ui/components/label";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";

// The workflow's own modules as its draft carries them: TypeScript files
// under `code/`, whose calculations its `local:` bindings call. Each is
// edited here and saved with the definition, in one revision; core builds
// and checks them as it would publish them.

/** Whether `a` and `b` carry the same modules, each with the same text. */
export const sameModules = (
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>
): boolean => {
  const paths = Object.keys(a);
  return (
    paths.length === Object.keys(b).length &&
    paths.every((path) => Object.hasOwn(b, path) && b[path] === a[path])
  );
};

/** `modules` without the one at `path`. */
const without = (
  modules: Readonly<Record<string, string>>,
  path: string
): Record<string, string> =>
  Object.fromEntries(Object.entries(modules).filter(([key]) => key !== path));

/** The id of the text field that edits the module at `path`. */
const fieldOf = (path: string): string => `workflow-module-${path}`;

export const ModuleFiles = ({
  modules,
  onChange,
  readOnly,
}: {
  modules: Readonly<Record<string, string>>;
  onChange: (modules: Record<string, string>) => void;
  readOnly: boolean;
}) => {
  const { t } = useLingui();
  const [path, setPath] = useState("");
  const paths = Object.keys(modules).toSorted();
  const full = paths.length >= workflowModuleLimits.files;
  const addable =
    workflowModulePattern.test(path) && !Object.hasOwn(modules, path) && !full;

  return (
    <section aria-labelledby="workflow-modules" className="flex flex-col gap-3">
      <h2 className="font-medium" id="workflow-modules">
        <Trans>Modules</Trans>
      </h2>
      {paths.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>
            No modules yet. A module holds calculations a task calls through a
            local binding.
          </Trans>
        </p>
      ) : null}
      {paths.map((file) => (
        <div className="flex flex-col gap-2" key={file}>
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={fieldOf(file)}>{file}</Label>
            <Button
              disabled={readOnly}
              onClick={() => {
                onChange(without(modules, file));
              }}
              size="sm"
              variant="ghost"
            >
              {t`Remove ${file}`}
            </Button>
          </div>
          <Textarea
            className="min-h-48"
            id={fieldOf(file)}
            onChange={(event) => {
              onChange({ ...modules, [file]: event.target.value });
            }}
            readOnly={readOnly}
            spellCheck={false}
            value={modules[file]}
            variant="code"
          />
        </div>
      ))}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (addable) {
            onChange({ ...modules, [path]: "" });
            setPath("");
          }
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="workflow-module-path">
            <Trans>Path of a new module</Trans>
          </Label>
          <Input
            id="workflow-module-path"
            onChange={(event) => {
              setPath(event.target.value);
            }}
            placeholder="code/total.ts"
            readOnly={readOnly}
            value={path}
          />
        </div>
        <Button disabled={readOnly || !addable} type="submit" variant="outline">
          <Trans>Add module</Trans>
        </Button>
      </form>
    </section>
  );
};
