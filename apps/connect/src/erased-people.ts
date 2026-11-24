import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { connections, erasedPeople } from "./db/schema.ts";

// Whose erasure began (person-erasure.ts): connect makes nothing of theirs
// once it has. Each check is SQL, for the statement that writes, so a
// flow or a call still under way when the erasure began writes nothing
// after it.

/** That `userId`'s erasure began, as SQL. */
export const erasureBegan = (userId: SQL | string): SQL =>
  sql`EXISTS (SELECT 1 FROM ${erasedPeople} WHERE ${erasedPeople.userId} = ${userId})`;

/** That the owner of personal connection `connectionId` is being erased, as SQL. */
export const ownerErased = (connectionId: string): SQL =>
  erasureBegan(
    sql`(SELECT ${connections.ownerUserId} FROM ${connections}
      WHERE ${connections.id} = ${connectionId}
        AND ${connections.scope} = 'personal')`
  );
