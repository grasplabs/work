// @vitest-environment happy-dom
import {
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "@grasp-os/runtime";
import type { Id } from "@grasp-os/runtime";
import { useMutation } from "@grasp-os/runtime/react";
import { DataGrid } from "@grasp-os/ui/components/data-grid";
import type { DataGridState } from "@grasp-os/ui/components/data-grid";
import { act } from "react";
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

// The data grid an App page shows its records in, against a real session
// client: what it asks the App's query for (the page size, then more on
// Load more; the search, sort and filters the person chose), how it shows
// and edits each field as the query declares it, what it does with the
// rows (an edit saved through the App's mutation, a bulk action on the
// rows selected, a row's own action, each failure shown), and what it
// shows when there is nothing, while it loads, and when the query fails.

const person = v.object({
  _id: v.id("people"),
  name: v.string(),
  team: v.enum(["sales", "support"]),
  active: v.boolean(),
  joined: v.timestamp(),
  score: v.number().nullable(),
  renews: v.timestamp(),
  tenure: v.duration(),
  address: v.object({ city: v.string(), country: v.enum(["nl", "de"]) }),
  bonus: v.number().optional(),
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

const movePerson = reference(
  "mutation",
  "people.move",
  v.object({ id: v.id("people"), team: v.enum(["sales", "support"]) }),
  v.null()
);

const rewardPerson = reference(
  "mutation",
  "people.reward",
  v.object({ id: v.id("people"), bonus: v.number().optional() }),
  v.null()
);

const renewPerson = reference(
  "mutation",
  "people.renew",
  v.object({ id: v.id("people"), renews: v.timestamp() }),
  v.null()
);

const scorePerson = reference(
  "mutation",
  "people.score",
  v.object({ id: v.id("people"), score: v.number().nullable() }),
  v.null()
);

const idOf = (index: number): Id<"people"> =>
  // SAFETY: the form of the store's IDs; the grid reads it as a key.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  `01890000-0000-7000-8000-00000000000${index}` as Id<"people">;

/**
 * When each person joined: a moment, which happens to be midnight UTC; a
 * moment all the same, shown with its time.
 */
const joined = Date.UTC(2026, 2, 14);

/** The day each person's contract renews, as a date field keeps a day. */
const renews = Date.UTC(2026, 11, 1);

const people = ["Ada", "Grace", "Linus", "Margaret", "Ken"].map(
  (name, index) => ({
    _id: idOf(index),
    name,
    team: index % 2 === 0 ? ("sales" as const) : ("support" as const),
    active: index !== 2,
    joined,
    renews,
    score: index === 0 ? 7 : null,
    // Two and a half hours.
    tenure: 9_000_000,
    address: { city: "Utrecht", country: "nl" as const },
    bonus: 3,
  })
);

/** A person as the list answers them. */
type Person = (typeof people)[number];

/** The query's arguments for what the person did, as a page hands them on. */
const argsOf = ({ search, sort, filters }: DataGridState<Person>) => {
  let order: "name" | "-name" | undefined;
  if (sort?.field === "name") {
    order = sort.direction === "asc" ? "name" : "-name";
  }
  return { search, sort: order, team: filters.team };
};

/** A host whose query answers `people` a page at a time, and whose mutations do as `saved` says. */
const hostOf = (
  saved: (sent: Sent) => Answer = () => ({ value: null }),
  records: readonly unknown[] = people
) =>
  testHost((sent) =>
    sent.contractId === "people.list"
      ? pageOf(records, sent.pagination)
      : saved(sent)
  );

/** An archive that does nothing, and succeeds. */
const archived = (): null => null;

const PeopleGrid = ({
  selected,
  opened,
  archive = archived,
}: {
  selected: string[][];
  opened: string[];
  archive?: () => unknown;
}) => {
  const rename = useMutation(renamePerson);
  const score = useMutation(scorePerson);
  const move = useMutation(movePerson);
  const renew = useMutation(renewPerson);
  const reward = useMutation(rewardPerson);
  return (
    <DataGrid
      args={argsOf}
      bulkActions={[
        {
          label: "Archive",
          onSelect: async (rows) => {
            selected.push(rows.map((row) => row.name));
            await archive();
          },
        },
      ]}
      columns={[
        {
          field: "name",
          sortable: true,
          edit: async (row, name) => await rename({ id: row._id, name }),
        },
        {
          field: "team",
          filter: { sales: "Sales", support: "Support" },
          edit: async (row, team) => await move({ id: row._id, team }),
        },
        "active",
        "joined",
        {
          field: "renews",
          day: true,
          edit: async (row, day) => await renew({ id: row._id, renews: day }),
        },
        {
          field: "score",
          edit: async (row, value) =>
            await score({ id: row._id, score: value }),
        },
        "tenure",
        "address",
        {
          field: "bonus",
          edit: async (row, bonus) => await reward({ id: row._id, bonus }),
        },
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

/** Presses `key` in `element`, as a person's keyboard does. */
const press = async (element: HTMLElement, key: string): Promise<void> => {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
    await Promise.resolve();
  });
  await settle();
};

describe("a data grid", () => {
  it("reads its first page, and more on Load more", async () => {
    const { client, reads } = hostOf();
    await rendered(client, grid);
    const first = { names: names(), read: reads.at(-1) };
    await click(find("button", "Load more"));
    const second = { names: names(), page: reads.at(-1)?.pagination };
    await click(find("button", "Load more"));
    expect({ first, second }).toStrictEqual({
      first: {
        names: ["Ada", "Grace"],
        read: {
          contractId: "people.list",
          input: { search: "" },
          pagination: { pageSize: 2, cursor: null },
        },
      },
      // The next page, from where the first ends.
      second: {
        names: ["Ada", "Grace", "Linus", "Margaret"],
        page: { pageSize: 2, cursor: "2" },
      },
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
    expect(reads.at(-1)?.pagination).toStrictEqual({
      pageSize: 2,
      cursor: null,
    });
  });

  it("shows each field as the query declares it", async () => {
    const { client } = hostOf();
    await rendered(client, grid);
    const cells = [...(document.querySelector("tbody tr")?.children ?? [])]
      .map((cell) => cell.textContent?.trim())
      .slice(1, -1);
    expect(cells).toStrictEqual([
      "Ada",
      "sales",
      "Yes",
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(joined),
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(renews),
      "7",
      `${new Intl.NumberFormat(undefined, { style: "unit", unit: "hour", unitDisplay: "short" }).format(2)} ${new Intl.NumberFormat(undefined, { style: "unit", unit: "minute", unitDisplay: "short" }).format(30)}`,
      "city: Utrecht, country: nl",
      "3",
    ]);
  });

  it("saves a cell edited in place through the App's mutation, and says why a save failed", async () => {
    let refuse = true;
    const { client, calls } = hostOf(() =>
      refuse
        ? { failed: "people.locked", message: "Ada's record is locked." }
        : { value: null }
    );
    await rendered(client, grid);
    await click(named("Edit Name for Ada"));
    await typeInto(named("Edit Name for Ada"), "Ada Lovelace");
    await leave(named("Edit Name for Ada"));
    const refused = {
      calls: [...calls],
      alert: find('[role="alert"]').textContent,
      // Kept as typed, to save again.
      kept: valueOf(named("Edit Name for Ada")).value,
    };
    refuse = false;
    await leave(named("Edit Name for Ada"));
    expect(refused).toStrictEqual({
      calls: [
        {
          contractId: "people.rename",
          input: { id: idOf(0), name: "Ada Lovelace" },
          pagination: undefined,
        },
      ],
      alert: "Ada's record is locked.",
      kept: "Ada Lovelace",
    });
    expect(calls).toHaveLength(2);
    // Saved: the editor closes, and nothing is wrong.
    expect(
      document.querySelector(
        '[role="alert"], input[aria-label="Edit Name for Ada"]'
      )
    ).toBeNull();
  });

  it("saves on Enter and drops the edit on Escape, back on the cell either way", async () => {
    const { client, calls } = hostOf();
    await rendered(client, grid);
    await click(named("Edit Name for Grace"));
    await typeInto(named("Edit Name for Grace"), "Grace Hopper");
    await press(named("Edit Name for Grace"), "Escape");
    const escaped = {
      calls: calls.length,
      focused: document.activeElement?.getAttribute("aria-label"),
      tag: document.activeElement?.tagName,
    };
    await click(named("Edit Name for Grace"));
    await typeInto(named("Edit Name for Grace"), "Grace Hopper");
    await press(named("Edit Name for Grace"), "Enter");
    expect({ escaped, calls }).toStrictEqual({
      escaped: { calls: 0, focused: "Edit Name for Grace", tag: "BUTTON" },
      calls: [
        {
          contractId: "people.rename",
          input: { id: idOf(1), name: "Grace Hopper" },
          pagination: undefined,
        },
      ],
    });
    expect(document.activeElement?.tagName).toBe("BUTTON");
  });

  it("edits a nullable number as a number, and clears it to null", async () => {
    const { client, calls } = hostOf();
    await rendered(client, grid);
    await click(named("Edit Score for Ada"));
    const editor = valueOf(named("Edit Score for Ada"));
    const type = editor.getAttribute("type");
    await typeInto(editor, "9");
    await press(named("Edit Score for Ada"), "Enter");
    await click(named("Edit Score for Ada"));
    await typeInto(named("Edit Score for Ada"), "");
    await press(named("Edit Score for Ada"), "Enter");
    expect({ type, sent: calls.map(({ input }) => input) }).toStrictEqual({
      type: "number",
      sent: [
        { id: idOf(0), score: 9 },
        { id: idOf(0), score: null },
      ],
    });
  });

  it("edits a day as that day, in UTC, wherever the person is", async () => {
    const { client, calls } = hostOf();
    await rendered(client, grid);
    await click(named("Edit Renews for Ada"));
    const editor = valueOf(named("Edit Renews for Ada"));
    const shown = { type: editor.getAttribute("type"), value: editor.value };
    await typeInto(editor, "2027-01-05");
    await press(named("Edit Renews for Ada"), "Enter");
    expect({ shown, sent: calls.map(({ input }) => input) }).toStrictEqual({
      shown: { type: "date", value: "2026-12-01" },
      sent: [{ id: idOf(0), renews: Date.UTC(2027, 0, 5) }],
    });
  });

  it("leaves out an optional number the person cleared, where a required one says it needs a value", async () => {
    const { client, calls } = hostOf();
    await rendered(client, grid);
    await click(named("Edit Bonus for Ada"));
    await typeInto(named("Edit Bonus for Ada"), "");
    await press(named("Edit Bonus for Ada"), "Enter");
    await click(named("Edit Renews for Ada"));
    await typeInto(named("Edit Renews for Ada"), "");
    await press(named("Edit Renews for Ada"), "Enter");
    expect({
      sent: calls.map(({ input }) => input),
      problem: find('[role="alert"]').textContent,
    }).toStrictEqual({
      sent: [{ id: idOf(0) }],
      problem: "Enter a value.",
    });
  });

  it("starts the selection afresh when the list is read for other arguments", async () => {
    const { client } = hostOf();
    await rendered(client, grid);
    await click(named("Select Ada"));
    await typeInto(named("Team"), "support");
    await typeInto(named("Team"), "");
    expect(document.querySelector('[aria-label="Selected rows"]')).toBeNull();
    expect(
      named("Select Ada").getAttribute("aria-checked") ??
        named("Select Ada").dataset.checked
    ).not.toBe("true");
  });

  it("keeps a choice's failed save open, its reason shown, after the person leaves it", async () => {
    const { client } = hostOf(() => ({
      failed: "people.full",
      message: "Support is full.",
    }));
    await rendered(client, grid);
    await click(named("Edit Team for Ada"));
    await typeInto(named("Edit Team for Ada"), "support");
    await leave(named("Edit Team for Ada"));
    expect(find('[role="alert"]').textContent).toBe("Support is full.");
    expect(valueOf(named("Edit Team for Ada")).value).toBe("support");
  });

  it("acts on the rows selected, and on one row from its menu", async () => {
    const selected: string[][] = [];
    const opened: string[] = [];
    const { client } = hostOf();
    await rendered(client, <PeopleGrid opened={opened} selected={selected} />);
    await click(named("Select Grace"));
    const count = find('[aria-label="Selected rows"] span').textContent;
    await click(find("button", "Archive"));
    // Done: nothing selected any more.
    const cleared =
      document.querySelector('[aria-label="Selected rows"]') === null;
    await click(named("Select all rows"));
    await click(find("button", "Archive"));
    await click(named("Actions for Ada"));
    await click(find('[role="menuitem"]', "Open"));
    expect({ count, cleared, selected, opened }).toStrictEqual({
      count: "1 selected",
      cleared: true,
      selected: [["Grace"], ["Ada", "Grace"]],
      opened: ["Ada"],
    });
  });

  it("shows a bulk action's failure, and keeps the selection to try again", async () => {
    const { client } = hostOf();
    await rendered(
      client,
      <PeopleGrid
        archive={() => {
          throw new Error("Archiving is paused.");
        }}
        opened={[]}
        selected={[]}
      />
    );
    await click(named("Select Ada"));
    await click(find("button", "Archive"));
    expect(find('[role="alert"]').textContent).toBe("Archiving is paused.");
    expect(find('[aria-label="Selected rows"] span').textContent).toBe(
      "1 selected"
    );
  });

  it("hides the columns the person hides", async () => {
    const { client } = hostOf();
    await rendered(client, grid);
    const before = find("thead").textContent;
    await click(find("button", "Columns"));
    await click(find('[role="menuitemcheckbox"]', "Active"));
    expect(before).toContain("Active");
    expect(find("thead").textContent).toBe(
      "NameTeamJoinedRenewsScoreTenureAddressBonusActions"
    );
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
        : pageOf(people, sent.pagination)
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
