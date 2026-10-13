import type {
  BindingChoices,
  DeclaredResource,
} from "@grasp-os/shared/resource-bindings";
import { describe, expect, it } from "vite-plus/test";

import { allChosen, formKey, targetOf } from "./binding-form.ts";

/** Knowledge declared with `collections`, offered `permissions`. */
const knowledge = (
  collections: string[],
  permissions: string[] = ["p-handbook", "p-salaries"]
): DeclaredResource => ({
  alias: "help",
  kind: "knowledge",
  contract: null,
  actions: [],
  operations: ["search"],
  collections,
  maxOutputTokens: null,
  structuredOutput: false,
  usedBy: ["help.find"],
  state: "unbound",
  binding: null,
  choices: {
    kind: "knowledge",
    permissions: permissions.map((permissionId) => ({
      permissionId,
      collectionId: `c-${permissionId}`,
      name: null,
    })),
    truncated: false,
  },
});

const choicesOf = (resource: DeclaredResource): BindingChoices => {
  if (resource.choices === null) {
    throw new Error("Expected choices");
  }
  return resource.choices;
};

describe("a resource's bind form", () => {
  it("sends only the collections declared now, whatever the form held before", () => {
    // Chosen while `handbook` and `salaries` were declared; then a newer
    // version declares `handbook` and `policies`.
    const chosen = { handbook: "p-handbook", salaries: "p-salaries" };
    const now = knowledge(["handbook", "policies"]);
    const unfinished = targetOf(now, choicesOf(now), "", chosen);
    const finished = targetOf(now, choicesOf(now), "", {
      ...chosen,
      policies: "p-salaries",
    });
    expect({
      ready: allChosen(now.collections, chosen),
      unfinished,
      finished,
    }).toStrictEqual({
      ready: false,
      unfinished: undefined,
      finished: {
        kind: "knowledge",
        collections: { handbook: "p-handbook", policies: "p-salaries" },
      },
    });
  });

  it("names nothing that isn't offered now", () => {
    const resource = knowledge(["handbook"]);
    const model: BindingChoices = {
      kind: "model",
      models: ["a/b"],
      truncated: false,
    };
    expect({
      model: targetOf(resource, model, "c/d", {}),
      template: targetOf(
        resource,
        { kind: "template", versions: [], truncated: false },
        "letter@1",
        {}
      ),
    }).toStrictEqual({ model: undefined, template: undefined });
  });

  it("starts afresh when the declaration, the version or the offers change", () => {
    const before = knowledge(["handbook", "salaries"]);
    const key = formKey("app", 1, before);
    expect({
      same: formKey("app", 1, knowledge(["handbook", "salaries"])) === key,
      declaration: formKey("app", 1, knowledge(["handbook"])) === key,
      version: formKey("app", 2, before) === key,
      offers:
        formKey("app", 1, knowledge(["handbook", "salaries"], ["p-other"])) ===
        key,
    }).toStrictEqual({
      same: true,
      declaration: false,
      version: false,
      offers: false,
    });
  });
});
