import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import {
  newSourceSchema,
  recallRequestSchema,
  sourceIdSchema,
} from "./contract.ts";
import type {
  NewSource,
  RecallRequest,
  Recalled,
  SourceId,
} from "./contract.ts";
import migrations from "./db/migrations/migrations.js";
import { sources } from "./db/schema.ts";
import { readerSetOf } from "./reader-sets.ts";
import { recall } from "./recall.ts";

/**
 * `input` as `schema` reads it, or an error that says why not: its paths
 * and the rules they broke, never the values. A ZodError itself reaches
 * the host over RPC as no more than its name.
 */
const checked = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`The Brain refused it: ${z.prettifyError(result.error)}`);
  }
  return result.data;
};

/**
 * The Brain's store: its sources, who may read them and their words, in
 * the object's own SQLite. Its public methods are the contract
 * (contract.ts `Brain`), and they are all there is: nothing else can read
 * its storage. Each checks what it is given, so nothing malformed is
 * stored or asked; who the reader is, is the host's to say.
 */
export class BrainStore extends DurableObject<unknown> {
  readonly #db = drizzle(this.ctx.storage);

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    // The schema is current before the object handles anything.
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.#db, migrations);
    });
  }

  /** Adds a source and its readers, in one transaction: whole or not at all. */
  addSource(source: NewSource): { id: SourceId } {
    const { text, access } = checked(newSourceSchema, source);
    const id = sourceIdSchema.parse(crypto.randomUUID());
    this.ctx.storage.transactionSync(() => {
      const readerSet = readerSetOf(this.#db, access);
      this.#db
        .insert(sources)
        .values({ id, readerSet, text, addedAt: new Date() })
        .run();
    });
    return { id };
  }

  /** What the reader may read of the sources holding the question's words. */
  recall(request: RecallRequest): Recalled {
    const { question, reader } = checked(recallRequestSchema, request);
    return recall(this.ctx.storage.sql, question, reader);
  }
}
