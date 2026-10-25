import { describe, expect, it } from "vite-plus/test";

import {
  brainSourceRefSchema,
  changeOptionsSchema,
  commandOptionsSchema,
  memoriesProposeChangeInputSchema,
  recallInputSchema,
  recallLimits,
  rememberInputSchema,
} from "../src/contract.ts";

// What the Brain's contract accepts from a caller, and what it refuses
// before any work: a caller sends a question or content, narrower
// filters, a budget and a command key, never who it is or what it may
// read. Core validates every call against these again.

/** Whether `schema` accepts `value`. */
const accepts = (
  schema: { safeParse: (value: unknown) => { success: boolean } },
  value: unknown
): boolean => schema.safeParse(value).success;

const documentRef = {
  kind: "document",
  documentId: "doc-onboarding",
  collectionId: "col-handbook",
  version: 3,
  section: 2,
};

describe("the Brain's contract", () => {
  it("takes a recall of a question with narrower filters and a budget within its limits", () => {
    expect(
      recallInputSchema.parse({
        query: "  Who owns onboarding?  ",
        filters: { collectionIds: ["col-handbook"] },
        budget: { maxItems: 5, maxTokens: 2000, deadlineMs: 3000 },
      })
    ).toStrictEqual({
      query: "Who owns onboarding?",
      filters: { collectionIds: ["col-handbook"] },
      budget: { maxItems: 5, maxTokens: 2000, deadlineMs: 3000 },
    });
  });

  it("refuses who the caller is, a wider reach, and budgets over its limits, in a recall", () => {
    const query = "Who owns onboarding?";
    expect({
      actor: accepts(recallInputSchema, { query, actor: "user-admin" }),
      admin: accepts(recallInputSchema, { query, admin: true }),
      deployment: accepts(recallInputSchema, { query, deployment: "acme" }),
      everything: accepts(recallInputSchema, {
        query,
        filters: { scope: "company" },
      }),
      noCollections: accepts(recallInputSchema, {
        query,
        filters: { collectionIds: [] },
      }),
      sql: accepts(recallInputSchema, { query, filters: { sql: "1=1" } }),
      items: accepts(recallInputSchema, {
        query,
        budget: { maxItems: recallLimits.maxItems + 1 },
      }),
      tokens: accepts(recallInputSchema, {
        query,
        budget: { maxTokens: recallLimits.maxTokens + 1 },
      }),
      deadline: accepts(recallInputSchema, {
        query,
        budget: { deadlineMs: recallLimits.deadlineMs + 1 },
      }),
      blank: accepts(recallInputSchema, { query: "   " }),
      sameCollectionTwice: accepts(recallInputSchema, {
        query,
        filters: { collectionIds: ["col-a", "col-a"] },
      }),
      validAt: accepts(recallInputSchema, {
        query,
        filters: { validAt: "2026-01-01T00:00:00Z" },
      }),
    }).toStrictEqual({
      actor: false,
      admin: false,
      deployment: false,
      everything: false,
      noCollections: false,
      sql: false,
      items: false,
      tokens: false,
      deadline: false,
      blank: false,
      sameCollectionTwice: false,
      validAt: false,
    });
  });

  it("takes a source reference only as a known kind at an exact version", () => {
    expect({
      document: accepts(brainSourceRefSchema, documentRef),
      memory: accepts(brainSourceRefSchema, {
        kind: "memory",
        memoryId: "mem-1",
        revision: 1,
      }),
      url: accepts(brainSourceRefSchema, {
        kind: "url",
        url: "https://example.com",
      }),
      noVersion: accepts(brainSourceRefSchema, {
        ...documentRef,
        version: undefined,
      }),
      versionZero: accepts(brainSourceRefSchema, {
        ...documentRef,
        version: 0,
      }),
      extraField: accepts(brainSourceRefSchema, {
        ...documentRef,
        href: "https://example.com",
      }),
    }).toStrictEqual({
      document: true,
      memory: true,
      url: false,
      noVersion: false,
      versionZero: false,
      extraField: false,
    });
  });

  it("takes something to remember with its evidence, never its scope or audience", () => {
    const remembered = {
      kind: "experience",
      text: "The old owner reference delayed this onboarding task.",
      sourceRefs: [documentRef],
    };
    expect({
      plain: accepts(rememberInputSchema, remembered),
      scope: accepts(rememberInputSchema, { ...remembered, scope: "company" }),
      audience: accepts(rememberInputSchema, {
        ...remembered,
        audience: "everyone",
      }),
      unknownKind: accepts(rememberInputSchema, {
        ...remembered,
        kind: "instruction",
      }),
      correction: accepts(memoriesProposeChangeInputSchema, {
        memoryId: "mem-1",
        statement: "Jan owns onboarding.",
        ownerId: "user-admin",
      }),
    }).toStrictEqual({
      plain: true,
      scope: false,
      audience: false,
      unknownKind: false,
      correction: false,
    });
  });

  it("takes a command's key and the revision it was made against, and nothing that names who retries", () => {
    expect({
      key: accepts(commandOptionsSchema, { idempotencyKey: "effect-0001" }),
      revision: accepts(commandOptionsSchema, {
        idempotencyKey: "effect-0001",
        expectedRevision: 4,
      }),
      shortKey: accepts(commandOptionsSchema, { idempotencyKey: "k" }),
      noKey: accepts(commandOptionsSchema, {}),
      actor: accepts(commandOptionsSchema, {
        idempotencyKey: "effect-0001",
        actor: "user-admin",
      }),
      changeWithoutRevision: accepts(changeOptionsSchema, {
        idempotencyKey: "effect-0001",
      }),
      change: accepts(changeOptionsSchema, {
        idempotencyKey: "effect-0001",
        expectedRevision: 2,
      }),
    }).toStrictEqual({
      key: true,
      revision: true,
      shortKey: false,
      noKey: false,
      actor: false,
      changeWithoutRevision: false,
      change: true,
    });
  });
});
