import type { Json } from "@grasp-os/shared/json";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import type { Member } from "../auth/identity.ts";
import {
  workflowResources,
  workflowResourceVersions,
} from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { listWorkflowResources } from "../workflow-resources.ts";

// The workflows a person may ask Stephen for (workflow-offers.ts), apart
// from the cards that offer them: the web's settings list them too, and
// the cards bring the Chat SDK, which core then loads only for a chat app.

/** A workflow the person may ask for, as the chat's code reads it. */
export interface AskableWorkflow {
  id: string;
  name: string;
  /** The version a start of it would run now. */
  version: number;
  /** The JSON Schema its input must match, as published. */
  input: Json | null;
}

const contractSchema = z.looseObject({ input: z.json().optional() });

/** The input schema of `contract`, a version's canonical JSON contract. */
const inputOf = (contract: string): Json | null => {
  try {
    return contractSchema.parse(JSON.parse(contract)).input ?? null;
  } catch {
    return null;
  }
};

/**
 * The workflows `person` could start themselves whose owners let people
 * ask for them, each at its current version, with the input it takes.
 */
export const askableFor = async (
  env: Env,
  person: Member
): Promise<AskableWorkflow[]> => {
  const listed = await listWorkflowResources(env, person);
  const theirs = listed.filter(({ currentVersion }) => currentVersion !== null);
  if (theirs.length === 0) {
    return [];
  }
  const rows = await drizzle(env.DB)
    .select({
      id: workflowResources.id,
      version: workflowResources.currentVersion,
      contract: workflowResourceVersions.contract,
    })
    .from(workflowResources)
    .innerJoin(
      workflowResourceVersions,
      and(
        eq(workflowResourceVersions.workflowResourceId, workflowResources.id),
        eq(workflowResourceVersions.version, workflowResources.currentVersion)
      )
    )
    .where(
      and(
        inList(
          workflowResources.id,
          theirs.map(({ id }) => id)
        ),
        eq(workflowResources.askable, true),
        isNull(workflowResources.deletedAt)
      )
    );
  const found = new Map(rows.map((row) => [row.id, row]));
  return theirs.flatMap(({ id, name }) => {
    const row = found.get(id);
    return row?.version === null || row === undefined
      ? []
      : [{ id, name, version: row.version, input: inputOf(row.contract) }];
  });
};
