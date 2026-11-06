import type { DefinitionOperation } from "@grasp-os/sdk/definition";
import type {
  DataModel,
  DataModelChange,
  DataModelField,
  DefinitionPlan,
  PlanField,
} from "@grasp-os/shared/data-model";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemMedia,
} from "@grasp-os/ui/components/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Switch } from "@grasp-os/ui/components/switch";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  ArchiveIcon,
  CircleAlertIcon,
  PlusIcon,
  ShieldIcon,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
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

/** A value as the plan says it: text as it is, anything else as JSON. */
export const valueText = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

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

const toneIcons: Record<PlanLine["tone"], ReactNode> = {
  added: <PlusIcon />,
  kept: <ArchiveIcon />,
  access: <ShieldIcon />,
  needs: <CircleAlertIcon />,
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
  <ItemGroup render={<ul />} spacing="tight">
    {lines.map(({ key, tone, text, asks }) => (
      <Item render={<li />} key={key} size="xs">
        <ItemMedia variant="icon">{toneIcons[tone]}</ItemMedia>
        <ItemContent>
          <span className="text-sm">{text}</span>
        </ItemContent>
        {asks === undefined || onAnswer === undefined ? null : (
          <Button
            onClick={() => {
              onAnswer(asks);
            }}
            size="xs"
            variant="outline"
          >
            <Trans>Give a value</Trans>
          </Button>
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
      <Field orientation="horizontal">
        <Switch
          aria-label={label}
          checked={value === "true"}
          onCheckedChange={(checked) => {
            onChange(checked ? "true" : "false");
          }}
        />
        <FieldLabel>{field.name}</FieldLabel>
      </Field>
    );
  }
  if (field.type.kind === "choice") {
    const items = field.type.values.map((each) => ({
      value: each,
      label: each,
    }));
    return (
      <Select
        items={items}
        onValueChange={(next: unknown) => {
          if (typeof next === "string") {
            onChange(next);
          }
        }}
        value={value === "" ? null : value}
      >
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue placeholder={t`Pick one`} />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  let type = "text";
  if (field.type.kind === "number") {
    type = "number";
  } else if (field.type.kind === "date") {
    type = "date";
  }
  return (
    <Input
      aria-label={label}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      type={type}
      value={value}
    />
  );
};

/** A change reviewed before it is made: its operation, what it does, and the values it asks for. */
interface Review {
  operation: ModelOperation;
  plan: DefinitionPlan;
  /** The field it would leave unanswered, as the model after it has it. */
  asks: DataModelField | undefined;
  /** Whether it removes something, which can't be put back here. */
  removes: boolean;
}

/** The field an operation adds or changes, which a value answers for. */
const targetOf = (operation: ModelOperation): PlanField | undefined => {
  if (operation.op === "addField") {
    return { table: operation.table, field: operation.name };
  }
  if (operation.op === "changeField") {
    return { table: operation.table, field: operation.field };
  }
  return undefined;
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
  onApply: (operation: ModelOperation) => Promise<boolean>;
  onClose: () => void;
}) => {
  const { t, i18n } = useLingui();
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
            asked.table !== targetOf(review.operation)?.table ||
            asked.field !== asks?.name
        );
  const submit = (): void => {
    if (review === undefined || waiting) {
      return;
    }
    const { operation } = review;
    void onApply(
      answer === undefined ||
        (operation.op !== "addField" && operation.op !== "changeField")
        ? operation
        : { ...operation, answer }
    );
  };
  const table = review === undefined ? "" : targetOf(review.operation)?.table;
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={review !== undefined}
    >
      <DialogContent className="sm:max-w-lg" closeLabel={t`Close`}>
        <DialogHeader>
          <DialogTitle>
            <Trans>Before you make this change</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              What publishing your changes will do to the records the App holds.
              Nothing changes for its people until you publish.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {lines.length === 0 ? null : <PlanList lines={lines} />}
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
                <p className="text-muted-foreground text-sm">
                  <Trans>
                    A field of this kind can&apos;t be given a value here. Make
                    it optional, or ask in the chat for a change in code.
                  </Trans>
                </p>
              )}
            </Field>
          )}
          <ErrorText>{failure}</ErrorText>
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              <Trans>Cancel</Trans>
            </Button>
            <Button
              disabled={busy || waiting}
              type="submit"
              variant={review?.removes === true ? "destructive" : "default"}
            >
              {review?.removes === true ? (
                <Trans>Remove</Trans>
              ) : (
                <Trans>Make the change</Trans>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
/**
 * Making changes of the model of the chat's draft of `app`: previewed
 * first, reviewed in a dialog where they remove, retype, change access or
 * need a value (`dialog`), and once made, `onMade` with the model after.
 */
export const useModelChanges = ({
  app,
  chatId,
  onMade,
}: {
  app: string;
  chatId: string;
  onMade: (model: DataModel, plan: DefinitionPlan) => void;
}) => {
  const action = useCoreAction();
  const [problem, setProblem] = useState<string>();
  const [review, setReview] = useState<Review>();
  const define = async (
    operation: ModelOperation,
    preview: boolean
  ): Promise<DataModelChange | undefined> =>
    await action.run(
      async (session) =>
        await session.chats.defineDraft(chatId, app, operation, preview)
    );
  /** Makes `operation` now, saying core's problem if it can't be made. */
  const apply = async (operation: ModelOperation): Promise<boolean> => {
    const made = await define(operation, false);
    if (made === undefined) {
      return false;
    }
    if (!made.ok) {
      setProblem(made.problem);
      return false;
    }
    setProblem(undefined);
    setReview(undefined);
    onMade(made.model, made.plan);
    return true;
  };
  /**
   * Makes `operation`, or opens its review first: answers whether it was
   * made or is in review, so a form that asked for it can start over.
   */
  const make = async (operation: ModelOperation): Promise<boolean> => {
    setProblem(undefined);
    const previewed = await define(operation, true);
    if (previewed === undefined) {
      return false;
    }
    if (!previewed.ok) {
      setProblem(previewed.problem);
      return false;
    }
    const target = targetOf(operation);
    const unanswered = previewed.plan.checks.some(
      ({ table, field, answer }) =>
        answer === null && table === target?.table && field === target.field
    );
    const asks =
      unanswered && target !== undefined
        ? fieldIn(previewed.model, target)
        : undefined;
    if (asks === undefined && !reviewed.has(operation.op)) {
      return await apply(operation);
    }
    setReview({
      operation,
      plan: previewed.plan,
      asks,
      removes: removals.has(operation.op),
    });
    return true;
  };
  const dialog = (
    <ReviewDialog
      busy={action.busy}
      failure={problem ?? action.failure}
      key={review === undefined ? "none" : JSON.stringify(review.operation)}
      onApply={apply}
      onClose={() => {
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
