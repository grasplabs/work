// @vitest-environment happy-dom
import {
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "@grasp-os/sdk";
import type { Id } from "@grasp-os/sdk";
import { useMutation } from "@grasp-os/sdk/react";
import { DataGrid } from "@grasp-os/ui/components/data-grid";
import type { DataGridState } from "@grasp-os/ui/components/data-grid";
import { describe, expect, it } from "vite-plus/test";

import {
  click,
  find,
  leave,
  named,
  pageOf,
  reference,
  rendered,
  settle,
  testHost,
  typeInto,
  valueOf,
} from "./test-host.tsx";
import type { Answer, Sent } from "./test-host.tsx";

// The data grid an App screen shows its records in, against a real session
// client: what it asks the App's query for (the page size, then more on
// Load more; the search, sort and filters the person chose), what it
// does with the rows (an edit saved through the App's mutation, a bulk
// action on the rows selected, a row's own action), and what it shows
// when there is nothing, while it loads, and when the query fails.

const person = v.object({
  _id: v.id("people"),
  _rev: v.number(),
  name: v.string(),
  team: v.enum(["sales", "support"]),
  active: v.boolean(),
});

const listPeople = reference(
  "query",
  "people.list",
  v.object({
    pagination: paginationOptionsValidator,
    search: v.string(),
    sort: v.enum(["name", "-name"]).optional(),
    team: v.enum(["sales", "support"]).optional(),
  }),
  paginationResultValidator(person)
);

const renamePerson = reference(
  "mutation",
  "people.rename",
  v.object({ id: v.id("people"), name: v.string().min(1) }),
  v.null()
);

const idOf = (index: number): Id<"people"> =>
  // SAFETY: the form of the store's IDs; the grid reads it as a key.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  `01890000-0000-7000-8000-00000000000${index}` as Id<"people">;

const people = ["Ada", "Grace", "Linus", "Margaret", "Ken"].map(
  (name, index) => ({
    _id: idOf(index),
    _rev: 1,
    name,
    team: index % 2 === 0 ? ("sales" as const) : ("support" as const),
    active: index !== 2,
  })
);

/** A person as the list answers them. */
type Person = (typeof people)[number];

/** The query's arguments for what the person did, as a screen hands them on. */
const argsOf = ({ search, sort, filters }: DataGridState<Person>) => {
  let order: "name" | "-name" | undefined;
  if (sort?.field === "name") {
    order = sort.direction === "asc" ? "name" : "-name";
  }
  return { search, sort: order, team: filters.team };
};

/** A host whose query answers `people` a window at a time, and whose rename does as `renamed` says. */
const hostOf = (
  renamed: (sent: Sent) => Answer = () => ({ value: null }),
  records: readonly unknown[] = people
) =>
  testHost((sent) =>
    sent.contractId === "people.list"
      ? pageOf(records, sent.extent)
      : renamed(sent)
  );

const PeopleGrid = ({
  selected,
  opened,
}: {
  selected: string[][];
  opened: string[];
}) => {
  const rename = useMutation(renamePerson);
  return (
    <DataGrid
      args={argsOf}
      bulkActions={[
        {
          label: "Archive",
          onSelect: (rows) => {
            selected.push(rows.map((row) => row.name));
          },
        },
      ]}
      columns={[
        {
          field: "name",
          sortable: true,
          edit: async (row, name) => await rename({ id: row._id, name }),
        },
        { field: "team", filter: { sales: "Sales", support: "Support" } },
        "active",
      ]}
      label="People"
      pageSize={2}
      query={listPeople}
      rowActions={[
        {
          label: "Open",
          onSelect: (row) => {
            opened.push(row.name);
          },
        },
      ]}
      search="Search people"
    />
  );
};

/** The grid, its actions recording into nothing a test reads. */
const grid = <PeopleGrid opened={[]} selected={[]} />;

/** The names in the grid's rows, in order. */
const names = (): string[] =>
  [...document.querySelectorAll("tbody tr")].map(
    (row) => row.querySelectorAll("td")[1]?.textContent?.trim() ?? ""
  );

/** What the last read asked the query for. */
const lastInput = (reads: readonly Sent[]) => reads.at(-1)?.input;

describe("a data grid", () => {
  it("reads its first page, and more on Load more", async () => {
    const { client, reads } = hostOf();
    await rendered(client, grid);
    const first = { names: names(), read: reads.at(-1) };
    await click(find("button", "Load more"));
    const second = { names: names(), extent: reads.at(-1)?.extent };
    await click(find("button", "Load more"));
    expect({ first, second }).toStrictEqual({
      first: {
        names: ["Ada", "Grace"],
        read: { contractId: "people.list", extent: 2, input: { search: "" } },
      },
      second: { names: ["Ada", "Grace", "Linus", "Margaret"], extent: 4 },
    });
    expect(names()).toHaveLength(people.length);
    // Everything loaded: nothing more to load.
    expect(document.body.textContent).not.toContain("Load more");
  });

  it("hands the query the search, sort and filter the person chose", async () => {
    const { client, reads } = hostOf();
    await rendered(client, grid);
    const asked: unknown[] = [];
    await typeInto(named("Search"), " gra ");
    // Not on each key: once typing settles.
    asked.push(lastInput(reads));
    await settle(350);
    asked.push(lastInput(reads));
    await click(find("th button", "Name"));
    asked.push(lastInput(reads));
    const ascending = find("th[aria-sort]").getAttribute("aria-sort");
    await click(find("th button", "Name"));
    asked.push(lastInput(reads));
    await click(find("th button", "Name"));
    asked.push(lastInput(reads));
    await typeInto(named("Team"), "support");
    asked.push(lastInput(reads));
    expect(asked).toStrictEqual([
      { search: "" },
      { search: "gra" },
      { search: "gra", sort: "name" },
      { search: "gra", sort: "-name" },
      { search: "gra" },
      { search: "gra", team: "support" },
    ]);
    expect(ascending).toBe("ascending");
    // Another filter starts the list again, at its first page.
    expect(reads.at(-1)?.extent).toBe(2);
  });

  it("saves a cell edited in place through the App's mutation, and says why a save failed", async () => {
    let refuse = true;
    const { client, calls } = hostOf(() =>
      refuse
        ? { failed: "people.locked", message: "Ada's record is locked." }
        : { value: null }
    );
    await rendered(client, grid);
    await click(named("Edit Name: Ada"));
    await typeInto(named("Edit Name"), "Ada Lovelace");
    await leave(named("Edit Name"));
    const refused = {
      calls: [...calls],
      alert: find('[role="alert"]').textContent,
      // Kept as typed, to save again.
      kept: valueOf(named("Edit Name")).value,
    };
    refuse = false;
    await leave(named("Edit Name"));
    expect(refused).toStrictEqual({
      calls: [
        {
          contractId: "people.rename",
          input: { id: idOf(0), name: "Ada Lovelace" },
          extent: undefined,
        },
      ],
      alert: "Ada's record is locked.",
      kept: "Ada Lovelace",
    });
    expect(calls).toHaveLength(2);
    // Saved: the editor closes, and nothing is wrong.
    expect(
      document.querySelector('[role="alert"], [aria-label="Edit Name"]')
    ).toBeNull();
  });

  it("acts on the rows selected, and on one row from its menu", async () => {
    const selected: string[][] = [];
    const opened: string[] = [];
    const { client } = hostOf();
    await rendered(client, <PeopleGrid opened={opened} selected={selected} />);
    const [, second] = document.querySelectorAll('[aria-label="Select row"]');
    if (second === undefined) {
      throw new Error("No second row to select.");
    }
    await click(second);
    const count = find('[role="toolbar"] span').textContent;
    await click(find("button", "Archive"));
    // Done: nothing selected any more.
    const cleared = !document.body.textContent?.includes("selected");
    await click(named("Select all rows"));
    await click(find("button", "Archive"));
    const [menu] = document.querySelectorAll('[aria-label="Row actions"]');
    if (menu === undefined) {
      throw new Error("No row menu.");
    }
    await click(menu);
    await click(find('[role="menuitem"]', "Open"));
    expect({ count, cleared, selected, opened }).toStrictEqual({
      count: "1 selected",
      cleared: true,
      selected: [["Grace"], ["Ada", "Grace"]],
      opened: ["Ada"],
    });
  });

  it("hides the columns the person hides", async () => {
    const { client } = hostOf();
    await rendered(client, grid);
    const before = find("thead").textContent;
    await click(find("button", "Columns"));
    await click(find('[role="menuitemcheckbox"]', "Active"));
    expect(before).toContain("Active");
    expect(find("thead").textContent).toBe("NameTeamRow actions");
  });

  it("says when there is nothing, and when nothing matches", async () => {
    const { client } = hostOf(undefined, []);
    await rendered(client, grid);
    const nothing = find("tbody").textContent;
    await typeInto(named("Team"), "sales");
    expect({ nothing, noMatches: find("tbody").textContent }).toStrictEqual({
      nothing: "Nothing here yet.",
      noMatches: "Nothing matches.",
    });
  });

  it("shows placeholder rows while its first page loads", async () => {
    // A host that hasn't answered: the first page is still loading.
    const { client } = testHost(() => "pending");
    await rendered(client, grid);
    expect(find("table").getAttribute("aria-busy")).toBe("true");
    expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3);
  });

  it("shows a failed query in its place, and reads it again on Try again", async () => {
    let fail = true;
    const { client } = testHost((sent) =>
      fail
        ? { failed: "people.unavailable", message: "The directory is down." }
        : pageOf(people, sent.extent)
    );
    await rendered(client, grid);
    expect(find('[role="alert"]').textContent).toContain(
      "The directory is down."
    );
    // The search stays usable while the list failed.
    expect(named("Search").getAttribute("type")).toBe("search");
    fail = false;
    await click(find("button", "Try again"));
    expect(names()).toStrictEqual(["Ada", "Grace"]);
  });
});
