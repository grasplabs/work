import type {
  WorkflowParamSetting,
  WorkflowParams,
} from "@grasp-os/shared/workflow-resources";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { Switch } from "@grasp-os/ui/components/switch";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { fieldValueOf, paramKindOf, paramText } from "./param-values.ts";
import type { ParamKind } from "./param-values.ts";

// An independent workflow's parameters, as its current version declares
// them (GRA-674): for anyone with a role, each with whether a value is
// set and, unless it is sensitive, the value; for its builders, a field
// each to set it, or put it back to its default. Each save names the
// configuration revision it read, so a change someone else made since
// is never overwritten: core refuses it (`workflow.params_conflict`) and
// says to reload. A sensitive value is never shown, only replaced.

/** What saving one parameter sends: a value, or back to its default. */
type Change = { value: unknown } | { reset: true };

/** What `setParams` takes for `change` of parameter `name`, read at `revision`. */
const changeInput = (name: string, revision: number, change: Change) =>
  "reset" in change
    ? { expectedRevision: revision, values: {}, reset: [name] }
    : { expectedRevision: revision, values: { [name]: change.value } };

/** A parameter's field, as its kind takes a value. */
const ParamInput = ({
  id,
  kind,
  param,
  editable,
  text,
  checked,
  errorId,
  onText,
  onChecked,
}: {
  id: string;
  kind: ParamKind;
  param: WorkflowParamSetting;
  editable: boolean;
  text: string;
  checked: boolean;
  /** The error's element, while the text isn't a value. */
  errorId: string | undefined;
  onText: (text: string) => void;
  onChecked: (checked: boolean) => void;
}) => {
  const { t } = useLingui();
  const replacing =
    param.sensitive && param.set
      ? t`Set. Type a new value to replace it.`
      : undefined;
  if (kind === "boolean") {
    return (
      <Switch
        checked={checked}
        disabled={!editable}
        id={id}
        onCheckedChange={onChecked}
      />
    );
  }
  if (kind === "json") {
    return (
      <Textarea
        aria-describedby={errorId}
        aria-invalid={errorId !== undefined}
        disabled={!editable}
        id={id}
        onChange={(event) => {
          onText(event.target.value);
        }}
        placeholder={replacing ?? t`A JSON value`}
        value={text}
        variant="code"
      />
    );
  }
  return (
    <Input
      aria-describedby={errorId}
      aria-invalid={errorId !== undefined}
      disabled={!editable}
      id={id}
      inputMode={kind === "number" ? "decimal" : undefined}
      onChange={(event) => {
        onText(event.target.value);
      }}
      placeholder={replacing}
      type={param.sensitive ? "password" : "text"}
      value={text}
    />
  );
};

const ParamField = ({
  workflow,
  revision,
  param,
  editable,
  onSaved,
}: {
  workflow: string;
  revision: number;
  param: WorkflowParamSetting;
  editable: boolean;
  onSaved: (params: WorkflowParams) => void;
}) => {
  const { busy, failure, run } = useCoreAction();
  const { t } = useLingui();
  const kind = paramKindOf(param.schema);
  const shownValue = param.set && !param.sensitive;
  const [text, setText] = useState(shownValue ? paramText(param.value) : "");
  const [checked, setChecked] = useState(param.value === true);
  const [saved, setSaved] = useState(false);
  const id = `param-${param.name}`;
  const read = fieldValueOf(kind, {
    text,
    checked,
    sensitive: param.sensitive,
  });
  const invalid = read === undefined && text.trim() !== "";
  const save = async (change: Change): Promise<void> => {
    setSaved(false);
    const updated = await run(
      async (session) =>
        await session.workflowResources.setParams(
          workflow,
          changeInput(param.name, revision, change)
        )
    );
    if (updated === undefined) {
      return;
    }
    onSaved(updated);
    setSaved(true);
    if ("reset" in change) {
      setText("");
    }
  };
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (read !== undefined) {
          void save(read);
        }
      }}
    >
      <span className="flex flex-wrap items-center gap-2">
        <label className="text-sm font-medium" htmlFor={id}>
          {param.label}
        </label>
        <code className="text-muted-foreground text-xs">{param.name}</code>
        {param.sensitive ? (
          <Badge variant="destructive">
            <Trans>Sensitive</Trans>
          </Badge>
        ) : null}
        {param.set ? null : (
          <Badge variant="outline">
            <Trans>Default</Trans>
          </Badge>
        )}
      </span>
      <ParamInput
        checked={checked}
        editable={editable}
        errorId={invalid ? `${id}-error` : undefined}
        id={id}
        kind={kind}
        onChecked={(next) => {
          setChecked(next);
          setSaved(false);
        }}
        onText={(next) => {
          setText(next);
          setSaved(false);
        }}
        param={param}
        text={text}
      />
      {invalid ? (
        <p className="text-destructive text-sm" id={`${id}-error`}>
          {t`That isn't a value this parameter takes.`}
        </p>
      ) : null}
      {editable ? (
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || read === undefined} size="sm" type="submit">
            <Trans>Save</Trans>
          </Button>
          {param.set ? (
            <Button
              disabled={busy}
              onClick={() => {
                void save({ reset: true });
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              <Trans>Use the default</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
      {saved ? (
        <output className="text-sm">
          <Trans>Saved.</Trans>
        </output>
      ) : null}
      <ErrorText>{failure}</ErrorText>
    </form>
  );
};

export const ResourceParams = ({
  workflow,
  loaded,
  editable,
}: {
  workflow: string;
  loaded: WorkflowParams;
  editable: boolean;
}) => {
  // What core returned for the last save here, over what the page loaded
  // with: its revision is the one the next save names.
  const [params, setParams] = useState(loaded);
  if (params.params.length === 0) {
    return (
      <p className="text-muted-foreground">
        <Trans>Its current version has no parameters.</Trans>
      </p>
    );
  }
  return (
    <div className="flex max-w-xl flex-col gap-6">
      <p className="text-muted-foreground">
        {editable ? (
          <Trans>
            A change applies to runs that start after it: runs already going
            keep the values they started with. Each change is recorded, without
            its value.
          </Trans>
        ) : (
          <Trans>Only the workflow&apos;s builders can change these.</Trans>
        )}
      </p>
      {params.params.map((param) => (
        <ParamField
          editable={editable}
          key={param.name}
          onSaved={setParams}
          param={param}
          revision={params.revision}
          workflow={workflow}
        />
      ))}
    </div>
  );
};
