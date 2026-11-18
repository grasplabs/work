import type { DefinitionOperation } from "@grasp-os/runtime/definition";
import type {
  DataModel,
  DataModelChange,
  DraftDataModel,
  DataModelField,
  DefinitionPlan,
  PlanField,
} from "@grasp-os/shared/data-model";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";

import { valueText } from "../format.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import { DatePicker } from "../grasp/date-picker/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { Form } from "../grasp/form/index.ts";
import {
  Alert as AlertIcon,
  Archive,
  Lock,
  Plus,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import { Switch } from "../grasp/switch/index.ts";
import { Text } from "../grasp/text/index.ts";
import { useCoreAction } from "../use-core-action.ts";

// A change of an App's data model from its Data view: what publishing it
// would do to the records the App holds is asked of core first (a preview,
// which saves nothing), and said in plain words before it is made when it
// removes something, changes who reaches the records, or needs a value
// for the records a field would check; a change that only adds is made at
// once. Core's own problem, for a change the definition can't take, is
// said as core says it.

/** An operation on the definition, as the Data view makes them. */
export type ModelOperation = DefinitionOperation;

/** A change of the model: one operation, or a few made as one (a field renamed and retyped). */
export type ModelChange = ModelOperation | readonly ModelOperation[];

/** A change's operations, in order. */
const operationsOf = (change: ModelChange): readonly ModelOperation[] =>
  "op" in change ? [change] : change;

/** One thing publishing does, in words, with what kind of thing it is. */
interface PlanLine {
  key: string;
  tone: "added" | "kept" | "access" | "needs";
  text: string;
  /** For a check without an answer: the field a value is asked for. */
  asks?: PlanField;
}

const lineOf = (
  key: string,
  tone: PlanLine["tone"],
  text: string,
  asks?: PlanField
): PlanLine => ({ key, tone, text, ...(asks === undefined ? {} : { asks }) });

/** What `plan` does, line by line, in the page's language. */
export const planLines = (plan: DefinitionPlan, i18n: I18n): PlanLine[] => [
  ...plan.addedTables.map((table) =>
    lineOf(`table:${table}`, "added", i18n._(msg`Adds the table ${table}.`))
  ),
  ...plan.renamedTables.map(({ from, to }) =>
    lineOf(
      `renamed:${from}`,
      "kept",
      i18n._(msg`Renames the table ${from} to ${to}; its records go with it.`)
    )
  ),
  ...plan.renamedFields.map(({ table, from, to }) =>
    lineOf(
      `renamed:${table}.${from}`,
      "kept",
      i18n._(msg`The values of ${from} in ${table} move to ${to}.`)
    )
  ),
  ...plan.addedFields.map(({ table, field }) =>
    lineOf(
      `field:${table}.${field}`,
      "added",
      i18n._(msg`Adds ${field} to ${table}.`)
    )
  ),
  ...plan.widenedFields.map(({ table, field }) =>
    lineOf(
      `widened:${table}.${field}`,
      "added",
      i18n._(
        msg`Lets ${field} in ${table} hold more. Every record already fits.`
      )
    )
  ),
  ...plan.checks.map(({ table, field, answer }) => {
    if (answer === null) {
      return lineOf(
        `check:${table}.${field}`,
        "needs",
        i18n._(
          msg`Records in ${table} that lack ${field} need a value before this can be published.`
        ),
        { table, field }
      );
    }
    const value = valueText(answer);
    return lineOf(
      `check:${table}.${field}`,
      "added",
      i18n._(msg`Records in ${table} that lack ${field} get “${value}”.`)
    );
  }),
  ...plan.keptTables.map((table) =>
    lineOf(
      `kept:${table}`,
      "kept",
      i18n._(
        msg`Keeps the records of ${table}, though nothing reads them any more.`
      )
    )
  ),
  ...plan.keptFields.map(({ table, field }) =>
    lineOf(
      `kept:${table}.${field}`,
      "kept",
      i18n._(
        msg`Keeps the values of ${field} in ${table}, though nothing reads them any more.`
      )
    )
  ),
  ...plan.accessChanges.map((table) =>
    lineOf(
      `access:${table}`,
      "access",
      i18n._(msg`Changes who can see and change the records of ${table}.`)
    )
  ),
  ...plan.sensitiveTables.map((table) =>
    lineOf(
      `sensitive:${table}`,
      "access",
      i18n._(
        msg`Makes ${table} sensitive: its history keeps no values, and every read is recorded.`
      )
    )
  ),
  ...plan.refused.map(({ table, field }) =>
    lineOf(
      `refused:${table}.${field ?? ""}`,
      "needs",
      field === undefined
        ? i18n._(
            msg`${table} needs a change in code before this can be published.`
          )
        : i18n._(
            msg`${field} in ${table} needs a change in code before this can be published.`
          )
    )
  ),
];

const toneIcons: Record<PlanLine["tone"], IconData> = {
  added: Plus,
  kept: Archive,
  access: Lock,
  needs: AlertIcon,
};

/**
 * What publishing does, line by line; a value asked for has its way to
 * give one (`onAnswer`).
 */
export const PlanList = ({
  lines,
  onAnswer,
}: {
  lines: PlanLine[];
  onAnswer?: (field: PlanField) => void;
}) => (
  <ItemGroup>
    {lines.map(({ key, tone, text, asks }) => (
      <Item key={key} size="xs">
        <ItemMedia icon={toneIcons[tone]} iconLook="inline" />
        <ItemContent>
          <ItemTitle>{text}</ItemTitle>
        </ItemContent>
        {asks === undefined || onAnswer === undefined ? null : (
          <ItemActions>
            <Button
              onClick={() => {
                onAnswer(asks);
              }}
              size="xs"
              variant="quiet"
            >
              <Trans>Give a value</Trans>
            </Button>
          </ItemActions>
        )}
      </Item>
    ))}
  </ItemGroup>
);

/** The field `field` names in `model`. */
export const fieldIn = (
  model: DataModel,
  { table, field }: PlanField
): DataModelField | undefined =>
  model.tables
    .find(({ name }) => name === table)
    ?.fields.find(({ name }) => name === field);

/** A value the records lacking a field get, as an operation takes it. */
type Answer = NonNullable<
  Extract<ModelOperation, { op: "addField" }>["answer"]
>;

/** The value an answer's text stands for, as `field` holds it; undefined while it reads as none. */
const answerOf = (field: DataModelField, text: string): Answer | undefined => {
  const { kind } = field.type;
  if (kind === "number") {
    const number = Number(text);
    return text.trim() === "" || !Number.isFinite(number) ? undefined : number;
  }
  if (kind === "boolean") {
    return text === "true";
  }
  if (kind === "date") {
    const time = Date.parse(text);
    return Number.isNaN(time) ? undefined : time;
  }
  return text === "" ? undefined : text;
};

/** Whether a field of this kind takes a value typed here; others only in code. */
const answerable = (field: DataModelField): boolean =>
  ["text", "email", "number", "boolean", "date", "choice"].includes(
    field.type.kind
  );

/** The value records lacking `field` get, as a person gives it. */
const AnswerInput = ({
  field,
  value,
  onChange,
}: {
  field: DataModelField;
  value: string;
  onChange: (value: string) => void;
}) => {
  const { t } = useLingui();
  const { name } = field;
  const label = t`Value for ${name}`;
  if (field.type.kind === "boolean") {
    return (
      <Switch
        checked={value === "true"}
        label={field.name}
        onCheckedChange={(checked) => {
          onChange(checked ? "true" : "false");
        }}
      />
    );
  }
  if (field.type.kind === "choice") {
    return (
      <Select
        items={field.type.values}
        onValueChange={(next) => {
          if (next !== null) {
            onChange(next);
          }
        }}
        value={value === "" ? null : value}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue placeholder={t`Pick one`} />
        </SelectTrigger>
        <SelectContent />
      </Select>
    );
  }
  if (field.type.kind === "date") {
    return (
      <DatePicker
        aria-label={label}
        onValueChange={(next: unknown) => {
          onChange(typeof next === "string" ? next : "");
        }}
        value={value === "" ? null : value}
      />
    );
  }
  return (
    <Input
      aria-label={label}
      inputMode={field.type.kind === "number" ? "decimal" : undefined}
      onValueChange={onChange}
      value={value}
    />
  );
};

/** A change reviewed before it is made: its operation, what it does, and the values it asks for. */
interface Review {
  change: ModelChange;
  /** What this change alone does. */
  plan: DefinitionPlan;
  /** The field it would leave unanswered, as the model after it has it. */
  asks: DataModelField | undefined;
  /** Whether it removes something, which can't be put back here. */
  removes: boolean;
  /** Hears whether it was made, or the review closed without it. */
  settle: (made: boolean) => void;
}

/** The field an operation adds or changes, which a value answers for. */
const targetOfOne = (operation: ModelOperation): PlanField | undefined => {
  if (operation.op === "addField") {
    return { table: operation.table, field: operation.name };
  }
  if (operation.op === "changeField") {
    return { table: operation.table, field: operation.field };
  }
  return undefined;
};

/** The field a change adds or changes last, which a value answers for. */
const targetOf = (change: ModelChange): PlanField | undefined =>
  operationsOf(change)
    .map(targetOfOne)
    .findLast((target) => target !== undefined);

/** `change` with `answer` given to the operation that adds or changes its field. */
const answered = (change: ModelChange, answer: Answer): ModelChange => {
  const operations = operationsOf(change).map((operation) =>
    operation.op === "addField" || operation.op === "changeField"
      ? { ...operation, answer }
      : operation
  );
  return operations.length === 1 && !Array.isArray(change)
    ? (operations[0] ?? change)
    : operations;
};

const removals: ReadonlySet<string> = new Set([
  "removeTable",
  "removeField",
  "removeIndex",
]);

/** Kinds of change shown before they are made, even with nothing asked. */
const reviewed: ReadonlySet<string> = new Set([
  ...removals,
  "changeField",
  "setAccess",
]);

/** A change's review: what it does, the value it needs, and making it. */
const ReviewDialog = ({
  review,
  busy,
  failure,
  onApply,
  onClose,
}: {
  review: Review | undefined;
  busy: boolean;
  failure: string | undefined;
  onApply: (change: ModelChange) => Promise<boolean>;
  onClose: () => void;
}) => {
  const { t, i18n } = useLingui();
  const formId = useId();
  const [text, setText] = useState("");
  const asks = review?.asks;
  const missing = asks?.name ?? "";
  const answer = asks === undefined ? undefined : answerOf(asks, text);
  const waiting = asks !== undefined && answer === undefined;
  const lines =
    review === undefined
      ? []
      : planLines(review.plan, i18n).filter(
          // A value asked for here is asked below, not as a line.
          ({ asks: asked }) =>
            asked === undefined ||
            asked.table !== targetOf(review.change)?.table ||
            asked.field !== asks?.name
        );
  const submit = (): void => {
    if (review === undefined || waiting) {
      return;
    }
    void onApply(
      answer === undefined ? review.change : answered(review.change, answer)
    );
  };
  const table = review === undefined ? "" : targetOf(review.change)?.table;
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={review !== undefined}
    >
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>
          <Trans>Before you make this change</Trans>
        </DialogTitle>
        <DialogBody>
          <Form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {lines.length === 0 && asks === undefined ? (
              <Text>
                <Trans>It changes no record the App holds.</Trans>
              </Text>
            ) : (
              <PlanList lines={lines} />
            )}
            {asks === undefined ? null : (
              <Field>
                <FieldLabel>
                  <Trans>
                    {table} already holds records. What should the ones without{" "}
                    {missing} get?
                  </Trans>
                </FieldLabel>
                {answerable(asks) ? (
                  <AnswerInput field={asks} onChange={setText} value={text} />
                ) : (
                  <Text tone="muted">
                    <Trans>
                      A field of this kind can&apos;t be given a value here.
                      Make it optional, or ask in the chat for a change in code.
                    </Trans>
                  </Text>
                )}
              </Field>
            )}
            {failure === undefined ? null : (
              <Alert title={failure} variant="danger" />
            )}
          </Form>
        </DialogBody>
        <DialogFooter>
          <DialogAction>
            <Trans>Cancel</Trans>
          </DialogAction>
          <Button
            disabled={busy || waiting}
            form={formId}
            type="submit"
            variant={review?.removes === true ? "danger" : "ink"}
          >
            {review?.removes === true ? (
              <Trans>Remove</Trans>
            ) : (
              <Trans>Make the change</Trans>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Making changes of the model of the App's draft of `app`: previewed
 * first, reviewed in a dialog where they remove, retype, change access or
 * need a value (`dialog`), and once made, `onMade` with the model after.
 */
export const useModelChanges = ({
  app,
  onMade,
}: {
  app: string;
  onMade: (made: Omit<DraftDataModel, "uses">) => void;
}) => {
  const action = useCoreAction();
  const [problem, setProblem] = useState<string>();
  const [review, setReview] = useState<Review>();
  const define = async (
    change: ModelChange,
    preview: boolean
  ): Promise<DataModelChange | undefined> =>
    await action.run(
      async (session) => await session.apps.drafts.define(app, change, preview)
    );
  /** Makes `change` now, saying core's problem if it can't be made. */
  const apply = async (change: ModelChange): Promise<boolean> => {
    const made = await define(change, false);
    if (made === undefined) {
      return false;
    }
    if (!made.ok) {
      setProblem(made.problem);
      return false;
    }
    setProblem(undefined);
    review?.settle(true);
    setReview(undefined);
    onMade({ model: made.model, plan: made.plan });
    return true;
  };
  /**
   * Makes `change`, or opens its review first: answers once it's made
   * (true), or once it can't be, or its review closes without it (false),
   * so a form that asked for it finishes only when it's made.
   */
  const make = async (change: ModelChange): Promise<boolean> => {
    setProblem(undefined);
    const previewed = await define(change, true);
    if (previewed === undefined) {
      return false;
    }
    if (!previewed.ok) {
      setProblem(previewed.problem);
      return false;
    }
    const operations = operationsOf(change);
    const target = targetOf(change);
    // A value is asked for only where the App's records need one: the
    // plan from the version people use.
    const unanswered = previewed.plan.checks.some(
      ({ table, field, answer }) =>
        answer === null && table === target?.table && field === target.field
    );
    // A value is asked only for a field every record must hold: records
    // that leave an optional one out, or no longer fit it, keep without.
    const field =
      unanswered && target !== undefined
        ? fieldIn(previewed.model, target)
        : undefined;
    const asks = field?.required === true ? field : undefined;
    if (asks === undefined && !operations.some(({ op }) => reviewed.has(op))) {
      return await apply(change);
    }
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setReview({
      change,
      plan: previewed.change,
      asks,
      removes: operations.some(({ op }) => removals.has(op)),
      settle: resolve,
    });
    return await promise;
  };
  const dialog = (
    <ReviewDialog
      busy={action.busy}
      failure={problem ?? action.failure}
      key={review === undefined ? "none" : JSON.stringify(review.change)}
      onApply={apply}
      onClose={() => {
        review?.settle(false);
        setReview(undefined);
        setProblem(undefined);
      }}
      review={review}
    />
  );
  return {
    make,
    busy: action.busy,
    // What went wrong outside a review: inside one, the dialog says it.
    failure: review === undefined ? (problem ?? action.failure) : undefined,
    dialog,
  };
};
