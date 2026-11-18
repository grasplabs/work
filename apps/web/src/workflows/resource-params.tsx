import type {
  WorkflowParamSetting,
  WorkflowParams,
} from "@grasp-os/shared/workflow-resources";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import { Input } from "../grasp/input/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { SettingRow, SettingsRows } from "../grasp/setting-row/index.ts";
import type { SettingRowState } from "../grasp/setting-row/index.ts";
import { Switch } from "../grasp/switch/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import {
  fieldValueOf,
  isBlank,
  nextFieldBase,
  paramKindOf,
  paramParts,
  paramText,
  partsOf,
  withPart,
} from "./param-values.ts";
import type { FieldBase, ParamKind } from "./param-values.ts";

// An independent workflow's parameters, as its current version declares
// them (GRA-674): for anyone with a role, each with whether a value is
// set and, unless it is sensitive, the value; for its builders, a field
// each to set it, or put it back to its default. Each save names the
// configuration revision it read, so a change someone else made since
// is never overwritten: core refuses it (`workflow.params_conflict`) and
// says to reload. A sensitive value is never shown, only replaced.

const styles = stylex.create({
  // A field, and under it why its text isn't a value and what to do with it.
  control: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    width: "100%",
    minWidth: 0,
  },
  parts: { display: "flex", flexWrap: "wrap", gap: grasp.space2 },
  part: { flexGrow: 1, flexBasis: 0, minWidth: 0 },
  // A currency's three letters need no more room than this.
  currency: { flexGrow: 0, width: grasp.controlLg, flexShrink: 0 },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
  },
  invalid: {
    margin: 0,
    color: grasp.danger,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
});

/** Where a parameter's row stands: saving, just saved, or at rest. */
const statusOf = (busy: boolean, saved: boolean): SettingRowState => {
  if (busy) {
    return "saving";
  }
  return saved ? "saved" : "idle";
};

/** What saving one parameter sends: a value, or back to its default. */
type Change = { value: unknown } | { reset: true };

/** What a field shows of `param` read at `revision`: never a sensitive value. */
const baseOf = (
  kind: ParamKind,
  param: WorkflowParamSetting,
  revision: number
): FieldBase => ({
  text: param.set && !param.sensitive ? paramText(kind, param.value) : "",
  checked: !param.sensitive && param.value === true,
  revision,
});

/** What `setParams` takes for `change` of parameter `name`, read at `revision`. */
const changeInput = (name: string, revision: number, change: Change) =>
  "reset" in change
    ? { expectedRevision: revision, values: {}, reset: [name] }
    : { expectedRevision: revision, values: { [name]: change.value } };

/** Money's or a schedule's field: an input for each of its parts. */
const PartsInput = ({
  id,
  kind,
  editable,
  text,
  errorId,
  onText,
}: {
  id: string;
  kind: "money" | "schedule";
  editable: boolean;
  text: string;
  errorId: string | undefined;
  onText: (text: string) => void;
}) => {
  const { t } = useLingui();
  const parts = partsOf(text);
  const labels: Record<string, string> = {
    amount: t`Amount`,
    currency: t`Currency`,
    cron: t`Cron fields`,
    timeZone: t`Time zone`,
  };
  const placeholders: Record<string, string> = {
    amount: "5000.00",
    currency: "EUR",
    cron: "0 8 * * 1",
    timeZone: "Europe/Amsterdam",
  };
  return (
    <div {...stylex.props(styles.parts)}>
      {paramParts[kind].map((part, index) => (
        <Input
          aria-describedby={errorId}
          aria-invalid={errorId !== undefined}
          aria-label={labels[part]}
          disabled={!editable}
          // The first part is what the parameter's label names.
          id={index === 0 ? id : `${id}-${part}`}
          inputMode={part === "amount" ? "decimal" : undefined}
          key={part}
          layout={part === "currency" ? styles.currency : styles.part}
          onValueChange={(value) => {
            onText(withPart(text, part, value));
          }}
          placeholder={placeholders[part]}
          value={parts[part] ?? ""}
        />
      ))}
    </div>
  );
};

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
  if (kind === "money" || kind === "schedule") {
    return (
      <PartsInput
        editable={editable}
        errorId={errorId}
        id={id}
        kind={kind}
        onText={onText}
        text={text}
      />
    );
  }
  if (kind === "boolean") {
    return (
      <Switch
        checked={checked}
        disabled={!editable}
        label={param.label}
        labelHidden
        onCheckedChange={(next) => {
          onChecked(next);
        }}
      />
    );
  }
  // A sensitive value is masked whatever its kind, JSON included: what a
  // builder types to replace it is never shown.
  if (kind === "json" && !param.sensitive) {
    return (
      <Textarea
        aria-describedby={errorId}
        aria-invalid={errorId !== undefined}
        disabled={!editable}
        id={id}
        onValueChange={onText}
        placeholder={replacing ?? t`A JSON value`}
        value={text}
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
      onValueChange={onText}
      placeholder={replacing ?? (kind === "json" ? t`A JSON value` : undefined)}
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
  const kind = paramKindOf(param.schema, param.sensitive);
  const fresh = baseOf(kind, param, revision);
  // What the field shows came from, its revision the one its save names.
  const [base, setBase] = useState(fresh);
  const [text, setText] = useState(fresh.text);
  const [checked, setChecked] = useState(fresh.checked);
  const [toggled, setToggled] = useState(false);
  if (fresh.revision !== base.revision) {
    const next = nextFieldBase(base, fresh, {
      edited: text !== base.text || checked !== base.checked || toggled,
      sensitive: param.sensitive,
    });
    // Kept as it is, it isn't set again: an update made while rendering
    // renders again, and would for as long as the revisions differ.
    if (next.base !== base) {
      setBase(next.base);
    }
    if (next.refill) {
      setText(fresh.text);
      setChecked(fresh.checked);
    }
  }
  const [saved, setSaved] = useState(false);
  const id = `param-${param.name}`;
  const read = fieldValueOf(kind, {
    text,
    checked,
    toggled,
    sensitive: param.sensitive,
  });
  const invalid = read === undefined && !isBlank(kind, text);
  const save = async (change: Change): Promise<void> => {
    setSaved(false);
    const updated = await run(
      async (session) =>
        await session.workflowResources.setParams(
          workflow,
          changeInput(param.name, base.revision, change)
        )
    );
    if (updated === undefined) {
      return;
    }
    onSaved(updated);
    setSaved(true);
    // Shows what was saved, as read back (a sensitive value never is), at
    // the revision the save made.
    const savedParam = updated.params.find(({ name }) => name === param.name);
    const after =
      savedParam === undefined
        ? { ...base, revision: updated.revision }
        : baseOf(kind, savedParam, updated.revision);
    setBase(after);
    setText(after.text);
    setChecked(after.checked);
    setToggled(false);
  };
  const status = statusOf(busy, saved);
  return (
    <SettingRow
      help={param.name}
      label={param.label}
      status={status}
      {...(failure === undefined ? {} : { error: failure })}
    >
      {(field) => (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (read !== undefined) {
              void save(read);
            }
          }}
          {...stylex.props(styles.control)}
        >
          <ParamInput
            checked={checked}
            editable={editable}
            errorId={invalid ? `${id}-error` : undefined}
            id={field.id}
            kind={kind}
            onChecked={(next) => {
              setChecked(next);
              setToggled(true);
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
            <p id={`${id}-error`} {...stylex.props(styles.invalid)}>
              {t`That isn't a value this parameter takes.`}
            </p>
          ) : null}
          <div {...stylex.props(styles.actions)}>
            {editable ? (
              <>
                <Button
                  disabled={busy || read === undefined}
                  size="sm"
                  type="submit"
                  variant="ink"
                >
                  {t`Save`}
                </Button>
                {param.set ? (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      void save({ reset: true });
                    }}
                    size="sm"
                    type="button"
                    variant="quiet"
                  >
                    {t`Use the default`}
                  </Button>
                ) : null}
              </>
            ) : null}
            {param.sensitive ? (
              <Badge size="sm" tone="attention">{t`Sensitive`}</Badge>
            ) : null}
            {param.set ? null : <Badge size="sm">{t`Default`}</Badge>}
          </div>
        </form>
      )}
    </SettingRow>
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
  const { t } = useLingui();
  // What core returned for the last save here, or what the page loaded,
  // whichever is newer: its revision is the one the next save names. The
  // page loads again once a version is published, which may declare other
  // parameters: taken as it comes, unless a save here is newer. Each field
  // keeps what is typed in it.
  const [params, setParams] = useState(loaded);
  const [seen, setSeen] = useState(loaded);
  if (loaded !== seen) {
    setSeen(loaded);
    if (loaded.revision >= params.revision) {
      setParams(loaded);
    }
  }
  return (
    <SectionCard
      aria-label={t`Parameters`}
      density="compact"
      flush
      {...(params.params.length === 0
        ? {}
        : {
            footer: editable
              ? t`A change applies to runs that start after it.`
              : t`Only the workflow's builders can change these.`,
          })}
    >
      {params.params.length === 0 ? (
        <Empty size="inline">{t`Its current version has no parameters.`}</Empty>
      ) : (
        <SettingsRows>
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
        </SettingsRows>
      )}
    </SectionCard>
  );
};
