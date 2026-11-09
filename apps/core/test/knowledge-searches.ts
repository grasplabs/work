/** What the tests of Knowledge search share (knowledge-search*.test.ts). */
import type { CollectionInput, KnowledgeApi } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";

import type { Idp } from "./idp.ts";
import { signedInApi, unique } from "./sign-in.ts";

/**
 * A person `idp` signs in with `role`: their Knowledge API, on a
 * connection of their own. Each test file has its own `idp`: `mockIdp()`
 * registers hooks, so it can't be called here.
 */
export const knowledgePersonOf = async (idp: Idp, role: Role) => {
  const person = await signedInApi(idp, role);
  const knowledge: KnowledgeApi = person.api.knowledge;
  return { ...person, knowledge };
};

export type Person = Awaited<ReturnType<typeof knowledgePersonOf>>;

/** A collection with `documents` in it, saved by `owner`. */
export const collectionWith = async (
  owner: Person,
  documents: { path: string; text: string }[],
  input?: CollectionInput
) => {
  const { id } = await owner.knowledge.createCollection(
    input ?? { name: `Notes ${unique()}`, access: "me" }
  );
  const saved = [];
  for (const { path, text } of documents) {
    // oxlint-disable-next-line no-await-in-loop -- saves in order
    const document = await owner.knowledge.saveDocument({
      collectionId: id,
      path,
      text,
      ifVersion: 0,
    });
    saved.push(document);
  }
  return { collectionId: id, documents: saved };
};
