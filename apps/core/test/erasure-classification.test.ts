import * as brain from "@grasp-os/brain/schema";
import { personColumn } from "@grasp-os/shared/person-columns";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vite-plus/test";

import * as auditLog from "../src/db/audit-log/schema.ts";
import * as core from "../src/db/core/schema.ts";
import * as dataStore from "../src/db/data-store/schema.ts";
import * as modelLedger from "../src/db/model-ledger/schema.ts";
import * as onboarding from "../src/db/onboarding/schema.ts";
import * as workspace from "../src/db/workspace/schema.ts";
import {
  erasureAreas,
  erasureInventory,
  noPerson,
} from "../src/person-erasure-inventory.ts";

// What erasing a person does to every place core keeps data, about them
// or not (GRA-903, GRA-1189): each table of core's databases is classified
// in person-erasure-inventory.ts. A new one, or one gone, fails here, so
// the inventory keeps up with the schemas.

// Every database core keeps: a new one goes here too, or the guard can't see it.
const schemas = {
  core,
  workspace,
  onboarding,
  dataStore,
  modelLedger,
  auditLog,
  brain,
};

/** Every table of core's databases, by `<database>.<table>`. */
const tables = new Map<string, SQLiteTable>(
  Object.entries(schemas).flatMap(([database, schema]) =>
    Object.values(schema).flatMap((value) =>
      is(value, SQLiteTable)
        ? [[`${database}.${getTableConfig(value).name}`, value] as const]
        : []
    )
  )
);

describe("the inventory of what erasing a person does", () => {
  it("classifies every table, and lists none that doesn't exist", () => {
    const listed = new Set(Object.keys(erasureInventory));
    expect({
      unclassified: [...tables.keys()]
        .filter((table) => !listed.has(table))
        .toSorted(),
      stale: [...listed].filter((table) => !tables.has(table)).toSorted(),
    }).toStrictEqual({ unclassified: [], stale: [] });
  });

  it("says why a table whose columns name a person holds none", () => {
    const unexplained = [...tables].flatMap(([name, table]) =>
      erasureInventory[name] === noPerson &&
      getTableConfig(table).columns.some((column) =>
        personColumn.test(column.name)
      )
        ? [name]
        : []
    );
    expect(unexplained).toStrictEqual([]);
  });

  it("names a known erasure area for every table it erases", () => {
    const areas = new Set<string>(erasureAreas);
    const unknown = Object.entries(erasureInventory).flatMap(([table, kind]) =>
      "erased" in kind && !areas.has(kind.erased) ? [table] : []
    );
    expect(unknown).toStrictEqual([]);
  });

  it("erases a table with the one it names when that one's deletes cascade to it", () => {
    const loose = Object.entries(erasureInventory).flatMap(([name, kind]) => {
      if (!("erased" in kind && kind.via !== undefined)) {
        return [];
      }
      const table = tables.get(name);
      const cascades =
        table !== undefined &&
        getTableConfig(table).foreignKeys.some((key) => {
          const { foreignTable } = key.reference();
          return (
            getTableConfig(foreignTable).name === kind.via &&
            key.onDelete === "cascade"
          );
        });
      return cascades ? [] : [name];
    });
    expect(loose).toStrictEqual([]);
  });
});
