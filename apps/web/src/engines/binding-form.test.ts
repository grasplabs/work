import type {
  BindingChoices,
  DeclaredResource,
} from "@grasp-os/shared/resource-bindings";
import { describe, expect, it } from "vite-plus/test";

import {
  allChosen,
  budgetFieldsOf,
  budgetOf,
  formKey,
  targetOf,
} from "./binding-form.ts";
import type { BudgetFields } from "./binding-form.ts";

/** A model form's budget fields as they start, but for those `typed`. */
const typed = (fields: Partial<BudgetFields>): BudgetFields => ({
  ...budgetFieldsOf(null),
  ...fields,
});

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

describe("a model binding's budget fields", () => {
  it("send no budget without a cap, and a cap typed either way", () => {
    expect({
      none: budgetOf(typed({})),
      day: budgetOf(typed({ perDay: " 2,50 ", alertAt: "90" })),
      request: budgetOf(typed({ perRequest: "0.01" })),
    }).toStrictEqual({
      none: { ok: true, budget: undefined },
      day: { ok: true, budget: { perDay: 2.5, alertAt: 90 } },
      // No day or month cap to alert on: the alert isn't sent.
      request: { ok: true, budget: { perRequest: 0.01 } },
    });
  });

  it("refuse what core refuses: under a cent, past the most, not an amount, an alert out of range", () => {
    expect({
      cent: budgetOf(typed({ perDay: "0.001" })),
      most: budgetOf(typed({ perMonth: "1000000001" })),
      text: budgetOf(typed({ perRequest: "2 dollars" })),
      negative: budgetOf(typed({ perRequest: "-1" })),
      alert: budgetOf(typed({ perMonth: "10", alertAt: "100" })),
      fraction: budgetOf(typed({ perDay: "10", alertAt: "50.5" })),
    }).toStrictEqual({
      cent: { ok: false, problems: { perDay: "amount" } },
      most: { ok: false, problems: { perMonth: "amount" } },
      text: { ok: false, problems: { perRequest: "amount" } },
      negative: { ok: false, problems: { perRequest: "amount" } },
      alert: { ok: false, problems: { alertAt: "alert" } },
      fraction: { ok: false, problems: { alertAt: "alert" } },
    });
  });

  it("start on the caps of the binding they replace, so replacing keeps them", () => {
    const budget = { perRequest: 0.5, perMonth: 300, alertAt: 70 };
    expect({
      kept: budgetOf(budgetFieldsOf(budget)),
      fresh: budgetFieldsOf(null),
    }).toStrictEqual({
      kept: { ok: true, budget },
      fresh: { perRequest: "", perDay: "", perMonth: "", alertAt: "80" },
    });
  });
});
