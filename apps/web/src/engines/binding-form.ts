import { modelBindingBudgetSchema } from "@grasp-os/shared/resource-bindings";
import type {
  BindingChoices,
  BindingTargetInput,
  DeclaredResource,
  ModelBindingBudget,
  ModelBindingBudgetInput,
  PublishedTemplate,
} from "@grasp-os/shared/resource-bindings";

// What an admin's bind form of an engine's resource (resource-bindings.tsx)
// decides, apart from how it looks: what it starts on, what it sends, and
// when it starts afresh. A refreshed review can change what is declared or
// offered under a form, so what it sends is built from the declaration as
// it is now, never from what the form held before.

/** Whether `choices` offer nothing to bind. */
export const noChoice = (choices: BindingChoices): boolean => {
  if (choices.kind === "model") {
    return choices.models.length === 0;
  }
  if (choices.kind === "template") {
    return choices.versions.length === 0;
  }
  return choices.permissions.length === 0;
};

/** A template version as a choice names it: its template and version. */
export const templateKey = ({
  templateId,
  version,
}: Pick<PublishedTemplate, "templateId" | "version">): string =>
  `${templateId}@${version}`;

/** The first of each choice, as a form starts. */
export const firstChoice = (choices: BindingChoices): string => {
  if (choices.kind === "model") {
    return choices.models[0] ?? "";
  }
  if (choices.kind === "template") {
    const [newest] = choices.versions;
    return newest === undefined ? "" : templateKey(newest);
  }
  return choices.permissions[0]?.permissionId ?? "";
};

/**
 * Each collection `declared` names, with the permission chosen for it
 * (empty while none is): the declared ones only, whatever else `chosen`
 * still holds from an earlier declaration.
 */
export const collectionsOf = (
  declared: readonly string[],
  chosen: Readonly<Record<string, string>>
): Record<string, string> =>
  Object.fromEntries(
    declared.map((collection) => [
      collection,
      Object.hasOwn(chosen, collection) ? (chosen[collection] ?? "") : "",
    ])
  );

/** Whether every collection `declared` names has a permission chosen. */
export const allChosen = (
  declared: readonly string[],
  chosen: Readonly<Record<string, string>>
): boolean =>
  Object.values(collectionsOf(declared, chosen)).every(
    (permission) => permission !== ""
  );

/**
 * The target the form's choice names for `resource` as declared now:
 * undefined while it names nothing that is offered.
 */
export const targetOf = (
  resource: Pick<DeclaredResource, "collections">,
  choices: BindingChoices,
  picked: string,
  chosen: Readonly<Record<string, string>>
): BindingTargetInput | undefined => {
  if (choices.kind === "model") {
    return choices.models.includes(picked)
      ? { kind: "model", model: picked }
      : undefined;
  }
  if (choices.kind === "connector") {
    return choices.permissions.some(
      ({ permissionId }) => permissionId === picked
    )
      ? { kind: "connector", permissionId: picked }
      : undefined;
  }
  if (choices.kind === "knowledge") {
    return allChosen(resource.collections, chosen)
      ? {
          kind: "knowledge",
          collections: collectionsOf(resource.collections, chosen),
        }
      : undefined;
  }
  const version = choices.versions.find(
    (published) => templateKey(published) === picked
  );
  return version === undefined
    ? undefined
    : {
        kind: "template",
        templateId: version.templateId,
        version: version.version,
      };
};

/** What a choice is, by kind: what tells one offer from another. */
const choiceIds = (choices: BindingChoices | null): string[] => {
  if (choices === null) {
    return [];
  }
  if (choices.kind === "model") {
    return choices.models;
  }
  if (choices.kind === "template") {
    return choices.versions.map(templateKey);
  }
  return choices.permissions.map(({ permissionId }) => permissionId);
};

/**
 * What a resource's forms start afresh on: the engine and version, the
 * declaration, its binding, and what is offered for it.
 */
export const formKey = (
  app: string,
  version: number,
  resource: DeclaredResource
): string =>
  JSON.stringify([
    app,
    version,
    resource.alias,
    resource.kind,
    resource.contract,
    resource.actions,
    resource.operations,
    resource.collections,
    resource.binding?.id ?? null,
    choiceIds(resource.choices),
  ]);

/** A model binding's caps as the form holds them: text, as typed. */
export interface BudgetFields {
  perRequest: string;
  perDay: string;
  perMonth: string;
  alertAt: string;
}

/** The caps a form holds, as opposed to when admins are alerted. */
export const capFields = ["perRequest", "perDay", "perMonth"] as const;

/** The alert a budget has unless the admin says otherwise. */
const defaultAlertAt = String(
  modelBindingBudgetSchema.parse({ perDay: 1 }).alertAt
);

/**
 * The fields a form starts on: the caps of the binding it replaces, so
 * replacing a binding keeps its caps unless the admin changes them; none
 * for a new binding, or one whose budget can't be read.
 */
export const budgetFieldsOf = (
  budget: ModelBindingBudget | null
): BudgetFields => ({
  perRequest: budget?.perRequest === undefined ? "" : String(budget.perRequest),
  perDay: budget?.perDay === undefined ? "" : String(budget.perDay),
  perMonth: budget?.perMonth === undefined ? "" : String(budget.perMonth),
  alertAt: budget === null ? defaultAlertAt : String(budget.alertAt),
});

/**
 * Whether `fields` set a cap admins are alerted on (a day's or a month's):
 * the alert means nothing without one.
 */
export const alerts = (fields: BudgetFields): boolean =>
  fields.perDay.trim() !== "" || fields.perMonth.trim() !== "";

/** Why a field doesn't hold what a budget may: an amount, or a percent. */
export type BudgetProblem = "amount" | "alert";

/** What a form's budget fields come to: a budget (none for no cap), or what is wrong. */
export type BudgetRead =
  | { ok: true; budget: ModelBindingBudgetInput | undefined }
  | { ok: false; problems: Partial<Record<keyof BudgetFields, BudgetProblem>> };

/** Why each field a form shows refused can't be sent. */
export type BudgetProblems = Partial<Record<keyof BudgetFields, BudgetProblem>>;

/**
 * The problems still standing once `before` became `after`: none for a
 * field that changed since it was refused, and none for the alert once no
 * cap it applies to is left (its field is off then, and isn't sent).
 */
export const problemsAfter = (
  problems: BudgetProblems,
  before: BudgetFields,
  after: BudgetFields
): BudgetProblems => {
  const standing: BudgetProblems = {};
  for (const field of [...capFields, "alertAt"] as const) {
    const problem = problems[field];
    const off = field === "alertAt" && !alerts(after);
    if (problem !== undefined && !off && before[field] === after[field]) {
      standing[field] = problem;
    }
  }
  return standing;
};

// Dollars as typed, with a decimal point or comma (`2.50`, `2,50`); whole
// percents.
const amountPattern = /^\d+(?:[.,]\d+)?$/u;
const percentPattern = /^\d+$/u;

/**
 * The budget `fields` set, each part checked by the schema core checks an
 * approval with (`modelBindingBudgetSchema`): each cap at least a cent, the alert a
 * whole percent from 1 to 99. Empty caps set no cap; with none, the
 * binding has no budget of its own, so a budget is never sent without a
 * cap. The alert is sent only with a cap it applies to.
 */
export const budgetOf = (fields: BudgetFields): BudgetRead => {
  const { shape } = modelBindingBudgetSchema;
  const problems: Partial<Record<keyof BudgetFields, BudgetProblem>> = {};
  const caps: Partial<Record<(typeof capFields)[number], number>> = {};
  for (const field of capFields) {
    const typed = fields[field].trim();
    if (typed === "") {
      continue;
    }
    const amount = amountPattern.test(typed)
      ? Number(typed.replace(",", "."))
      : Number.NaN;
    if (shape[field].safeParse(amount).success) {
      caps[field] = amount;
    } else {
      problems[field] = "amount";
    }
  }
  let alertAt: number | undefined;
  if (alerts(fields)) {
    const typed = fields.alertAt.trim();
    const percent = percentPattern.test(typed) ? Number(typed) : Number.NaN;
    if (shape.alertAt.safeParse(percent).success) {
      alertAt = percent;
    } else {
      problems.alertAt = "alert";
    }
  }
  if (Object.keys(problems).length > 0) {
    return { ok: false, problems };
  }
  if (Object.keys(caps).length === 0) {
    return { ok: true, budget: undefined };
  }
  return {
    ok: true,
    budget: { ...caps, ...(alertAt === undefined ? {} : { alertAt }) },
  };
};
