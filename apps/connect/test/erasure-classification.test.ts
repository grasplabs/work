import { personColumn } from "@grasp-os/shared/person-columns";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vite-plus/test";

import * as schema from "../src/db/schema.ts";
import {
  erasureInventory,
  noPerson,
  reviewedPersonColumns,
} from "../src/person-erasure-inventory.ts";

// What erasing a person does to every place connect keeps data, about them
// or not (GRA-903, GRA-1189): each table is classified in
// person-erasure-inventory.ts. A new one, or one gone, fails here.

/** Every table of connect's database, by name. */
const tables = new Map(
  Object.values(schema).flatMap((value) =>
    is(value, SQLiteTable) ? [[getTableConfig(value).name, value] as const] : []
  )
);

describe("the inventory of what erasing a person does in connect", () => {
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

  it("has reviewed every column that names a person, on every table", () => {
    const changed = [...tables].flatMap(([name, table]) => {
      const columns = getTableConfig(table)
        .columns.map((column) => column.name)
        .filter((column) => personColumn.test(column))
        .toSorted();
      const reviewed = reviewedPersonColumns[name] ?? [];
      return columns.join(",") === [...reviewed].toSorted().join(",")
        ? []
        : [{ table: name, columns, reviewed }];
    });
    const stale = Object.keys(reviewedPersonColumns).filter(
      (name) => !tables.has(name)
    );
    expect({ changed, stale }).toStrictEqual({ changed: [], stale: [] });
  });
});
