import type {
  BindingChoices,
  DeclaredResource,
} from "@grasp-os/shared/resource-bindings";
import { describe, expect, it } from "vite-plus/test";

import { formKey, targetOf } from "./binding-form.ts";

/** The Brain declared with `operations`, offered `permissions`. */
const brain = (
  operations: string[] = ["recall"],
  permissions: string[] = ["p-brain", "p-other"]
): DeclaredResource => ({
  alias: "brain",
  kind: "brain",
  contract: null,
  actions: [],
  operations,
  maxOutputTokens: null,
  state: "unbound",
  binding: null,
  choices: {
    kind: "brain",
    permissions: permissions.map((permissionId) => ({ permissionId })),
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
  it("sends the permission picked, of the kind offered", () => {
    expect(targetOf(choicesOf(brain()), "p-other")).toStrictEqual({
      kind: "brain",
      permissionId: "p-other",
    });
  });

  it("names nothing that isn't offered now", () => {
    const model: BindingChoices = {
      kind: "model",
      models: ["a/b"],
      truncated: false,
    };
    expect({
      model: targetOf(model, "c/d"),
      grasp: targetOf(
        { kind: "grasp", permissions: [], truncated: false },
        "p-statistics"
      ),
      // Picked while it was offered; a refreshed review no longer offers it.
      brain: targetOf(choicesOf(brain(["recall"], ["p-new"])), "p-brain"),
    }).toStrictEqual({ model: undefined, grasp: undefined, brain: undefined });
  });

  it("starts afresh when the declaration, the version or the offers change", () => {
    const before = brain();
    const key = formKey("app", 1, before);
    expect({
      same: formKey("app", 1, brain()) === key,
      declaration: formKey("app", 1, brain(["recall", "remember"])) === key,
      version: formKey("app", 2, before) === key,
      offers: formKey("app", 1, brain(["recall"], ["p-new"])) === key,
    }).toStrictEqual({
      same: true,
      declaration: false,
      version: false,
      offers: false,
    });
  });
});
