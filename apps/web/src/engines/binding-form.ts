import type {
  BindingChoices,
  BindingTargetInput,
  DeclaredResource,
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
