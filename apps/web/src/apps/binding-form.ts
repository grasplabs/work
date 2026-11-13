import type {
  BindingChoices,
  BindingTargetInput,
  DeclaredResource,
} from "@grasp-os/shared/resource-bindings";

// What an admin's bind form of an App's resource (resource-bindings.tsx)
// decides, apart from how it looks: what it starts on, what it sends, and
// when it starts afresh. A refreshed review can change what is declared or
// offered under a form, so what it sends is built from what is offered
// now, never from what the form held before.

/** Whether `choices` offer nothing to bind. */
export const noChoice = (choices: BindingChoices): boolean => {
  if (choices.kind === "model") {
    return choices.models.length === 0;
  }
  return choices.permissions.length === 0;
};

/** The first of each choice, as a form starts. */
export const firstChoice = (choices: BindingChoices): string => {
  if (choices.kind === "model") {
    return choices.models[0] ?? "";
  }
  return choices.permissions[0]?.permissionId ?? "";
};

/**
 * The target the form's choice names: undefined while it names nothing
 * that is offered now.
 */
export const targetOf = (
  choices: BindingChoices,
  picked: string
): BindingTargetInput | undefined => {
  if (choices.kind === "model") {
    return choices.models.includes(picked)
      ? { kind: "model", model: picked }
      : undefined;
  }
  return choices.permissions.some(({ permissionId }) => permissionId === picked)
    ? { kind: choices.kind, permissionId: picked }
    : undefined;
};

/** What a choice is, by kind: what tells one offer from another. */
const choiceIds = (choices: BindingChoices | null): string[] => {
  if (choices === null) {
    return [];
  }
  if (choices.kind === "model") {
    return choices.models;
  }
  return choices.permissions.map(({ permissionId }) => permissionId);
};

/**
 * What a resource's forms start afresh on: the App and version, the
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
    resource.binding?.id ?? null,
    choiceIds(resource.choices),
  ]);
