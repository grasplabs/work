import type {
  WorkflowParamSetting,
  WorkflowParams,
} from "@grasp-os/shared/workflow-resources";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldStatus,
} from "@grasp-os/ui/components/field";
import type { FieldStatusValue } from "@grasp-os/ui/components/field";
import { Input, SecretInput } from "@grasp-os/ui/components/input";
import { Switch } from "@grasp-os/ui/components/switch";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { colors, font, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

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
import { SectionCard } from "./section-card.tsx";

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
    gap: space["2"],
    width: "100%",
    minWidth: 0,
  },
  parts: { display: "flex", flexWrap: "wrap", gap: space["2"] },
  part: { flexGrow: 1, flexBasis: 0, minWidth: 0 },
  // A currency's three letters need no more room than this.
  currency: { flexGrow: 0, width: size.controlLg, flexShrink: 0 },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
  invalid: {
    margin: 0,
    color: colors.destructive,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
});

/** Where a parameter's row stands: saving, just saved, or at rest. */
const statusOf = (busy: boolean, saved: boolean): FieldStatusValue => {
  if (busy) {
    return "loading";
  }
  return saved ? "success" : "idle";
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
  kind,
  editable,
  text,
  errorId,
  onText,
}: {
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
      {paramParts[kind].map((part) => (
        <Input
          aria-describedby={errorId}
          aria-invalid={errorId !== undefined}
          aria-label={labels[part]}
          disabled={!editable}
          inputMode={part === "amount" ? "decimal" : undefined}
          key={part}
          style={part === "currency" ? styles.currency : styles.part}
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
  kind,
  param,
  editable,
  text,
  checked,
  errorId,
  onText,
  onChecked,
}: {
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
        aria-label={param.label}
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
        onValueChange={onText}
        placeholder={replacing ?? t`A JSON value`}
        value={text}
      />
    );
  }
  const placeholder =
    replacing ?? (kind === "json" ? t`A JSON value` : undefined);
  // A sensitive value is a secret: masked, never offered to a password
  // manager, never read back by an agent.
  if (param.sensitive) {
    return (
      <SecretInput
        aria-describedby={errorId}
        aria-invalid={errorId !== undefined}
        disabled={!editable}
        inputMode={kind === "number" ? "decimal" : undefined}
        onValueChange={onText}
        placeholder={placeholder}
        value={text}
      />
    );
  }
  return (
    <Input
      aria-describedby={errorId}
      aria-invalid={errorId !== undefined}
      disabled={!editable}
      inputMode={kind === "number" ? "decimal" : undefined}
      onValueChange={onText}
      placeholder={placeholder}
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
    <Field
      orientation="responsive"
      {...(failure === undefined ? {} : { "data-invalid": true })}
    >
      <FieldContent>
        <FieldLabel>{param.label}</FieldLabel>
        <FieldDescription>{param.name}</FieldDescription>
        {failure === undefined ? null : <FieldError>{failure}</FieldError>}
      </FieldContent>
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
                  variant="outline"
                >
                  {t`Use the default`}
                </Button>
              ) : null}
            </>
          ) : null}
          {param.sensitive ? (
            <Badge size="sm" variant="warning">{t`Sensitive`}</Badge>
          ) : null}
          {param.set ? null : <Badge size="sm">{t`Default`}</Badge>}
        </div>
      </form>
      <FieldStatus status={status} />
    </Field>
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
        <Empty size="sm">
          <EmptyHeader>
            <EmptyDescription>{t`Its current version has no parameters.`}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <FieldGroup>
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
        </FieldGroup>
      )}
    </SectionCard>
  );
};
