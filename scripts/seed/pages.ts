/**
 * The demo Apps' pages: each App keeps one table of the work its process
 * moves through four stages, and its page (`src/routes/index.tsx`) counts
 * the records in each stage and lists them, a record's stage changed in
 * place. Written as an App's builder would, with the public SDK and
 * `@grasp-os/ui` only, as the example Apps in apps/docs/content/examples
 * are. The seed adds each table's records through the App's data import.
 */
import type { DefinitionOperation } from "@grasp-os/runtime/definition";

/** An App's board: its table, its four stages, and the records it starts with. */
export interface Board {
  title: string;
  intro: string;
  /** The table, as `api.<table>` names it: `deals`. */
  table: string;
  /** What one record is, as its first column's heading: `Deal`. */
  noun: string;
  /** Its second text field: who or what a record is for. */
  party: string;
  /** Its stages in order, each by its label; the last is done. */
  stages: Readonly<Record<string, string>>;
  /** Whether a record has an amount in euros. */
  money: boolean;
  /** Title, party, stage and, with `money`, euros. */
  records: readonly (readonly [string, string, string, number?])[];
}

/** The board of each App, by the App's name. */
export const boards: Readonly<Record<string, Board>> = {
  "Opportunity-to-Cash": {
    title: "Advice pipeline",
    intro: "Every advice file from first call to invoice.",
    table: "deals",
    noun: "Deal",
    party: "client",
    stages: { lead: "Lead", proposal: "Proposal", won: "Won", paid: "Paid" },
    money: true,
    records: [
      ["Mortgage advice", "J. Visser", "lead", 2450],
      ["Pension review", "Bakker Holding", "proposal", 3800],
      ["Wealth plan", "M. de Jong", "proposal", 6200],
      ["Mortgage advice", "S. Smit", "won", 2450],
      ["Annual review", "Van Dijk BV", "paid", 1200],
      ["Insurance check", "L. Mulder", "paid", 950],
    ],
  },
  "Issue-to-Resolution": {
    title: "Service desk",
    intro: "Client questions and complaints until they are resolved.",
    table: "tickets",
    noun: "Ticket",
    party: "client",
    stages: {
      open: "Open",
      working: "In progress",
      waiting: "Waiting on client",
      resolved: "Resolved",
    },
    money: false,
    records: [
      ["Statement missing for Q3", "Bakker Holding", "open"],
      ["Wrong IBAN on invoice", "J. Visser", "open"],
      ["Question about advice fee", "S. Smit", "working"],
      ["Documents for mortgage file", "M. de Jong", "waiting"],
      ["Complaint about response time", "Van Dijk BV", "working"],
      ["Change of address", "L. Mulder", "resolved"],
    ],
  },
  "Purchase-to-Pay": {
    title: "Invoices to pay",
    intro: "Supplier invoices from receipt to payment.",
    table: "invoices",
    noun: "Invoice",
    party: "supplier",
    stages: {
      received: "Received",
      approved: "Approved",
      scheduled: "Scheduled",
      paid: "Paid",
    },
    money: true,
    records: [
      ["INV-2026-1184", "Kantoorhuis Utrecht", "received", 1840],
      ["INV-2026-1185", "Datafeed Europe", "received", 4200],
      ["INV-2026-1171", "CleanCo", "approved", 612],
      ["INV-2026-1162", "Legal & Partners", "scheduled", 3150],
      ["INV-2026-1150", "Kantoorhuis Utrecht", "paid", 1840],
      ["INV-2026-1149", "TelecomNL", "paid", 289],
    ],
  },
  "Risk-to-Compliance": {
    title: "Risk register",
    intro: "Risks from first sighting until they are under control.",
    table: "risks",
    noun: "Risk",
    party: "area",
    stages: {
      identified: "Identified",
      assessed: "Assessed",
      mitigating: "Mitigating",
      controlled: "Controlled",
    },
    money: false,
    records: [
      ["Advice given without suitability check", "Advice", "identified"],
      ["Client files kept past retention", "Operations", "assessed"],
      ["Single supplier for market data", "Finance", "mitigating"],
      ["Shared passwords on desk laptops", "IT", "mitigating"],
      ["Late AFM incident reporting", "Compliance", "controlled"],
    ],
  },
  "Record-to-Report": {
    title: "Month-end close",
    intro: "This month's close, task by task.",
    table: "closeTasks",
    noun: "Task",
    party: "assignee",
    stages: {
      todo: "To do",
      doing: "Doing",
      review: "In review",
      done: "Done",
    },
    money: false,
    records: [
      ["Reconcile bank accounts", "Eva", "done"],
      ["Book accruals", "Eva", "review"],
      ["Revenue recognition", "Daan", "doing"],
      ["Intercompany balances", "Daan", "todo"],
      ["Management report", "Eva", "todo"],
    ],
  },
  "Hire-to-Retire": {
    title: "Hiring",
    intro: "Candidates for the open roles, from application to hire.",
    table: "candidates",
    noun: "Candidate",
    party: "role",
    stages: {
      applied: "Applied",
      interview: "Interview",
      offer: "Offer",
      hired: "Hired",
    },
    money: false,
    records: [
      ["Femke Jansen", "Mortgage adviser", "applied"],
      ["Ahmed El Amrani", "Mortgage adviser", "interview"],
      ["Lotte Vermeer", "Compliance officer", "interview"],
      ["Tom Hendriks", "Financial controller", "offer"],
      ["Iris de Graaf", "Client service", "hired"],
    ],
  },
};

/** The definition operations that add `board`'s table. */
export const boardOperations = (board: Board): DefinitionOperation[] => [
  {
    op: "addTable",
    name: board.table,
    fields: {
      title: "v.string().trim().min(1).max(200)",
      [board.party]: "v.string().trim().max(200)",
      stage: `v.enum(${JSON.stringify(Object.keys(board.stages))})`,
      ...(board.money ? { amount: "v.money()" } : {}),
    },
    access: { read: "appMembers", write: "appMembers" },
  },
  { op: "addIndex", table: board.table, name: "by_stage", fields: ["stage"] },
];

/** `board`'s server functions and page, by path. */
export const boardFiles = ({
  title,
  intro,
  table,
  noun,
  party,
  stages,
  money,
}: Board): Record<string, string> => {
  const done = Object.keys(stages).at(-1);
  const columns = [
    `{ field: "title", label: ${JSON.stringify(noun)} }`,
    JSON.stringify(party),
    ...(money ? ['"amount"'] : []),
    `{
            field: "stage",
            cell: (row) => stages[row.stage],
            edit: async (row, stage) => await setStage({ id: row._id, stage }),
          }`,
  ];
  return {
    [`server/${table}.ts`]: `import {
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "@grasp-os/sdk";
import { doc, mutation, query } from "@server/_generated/server";

const stage = v.enum(${JSON.stringify(Object.keys(stages))});

export const list = query({
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(doc("${table}")),
  handler: async (ctx, args) =>
    await ctx.db
      .query("${table}")
      .withIndex("by_stage")
      .paginate(args.pagination),
});

export const byStage = query({
  args: {},
  returns: v
    .array(v.object({ stage, count: v.number().integer().min(0) }))
    .max(${Object.keys(stages).length}),
  handler: async (ctx) => {
    const groups = await ctx.db
      .query("${table}")
      .withIndex("by_stage")
      .group({ by: ["stage"] });
    return groups.map(({ key, count }) => ({ stage: key.stage, count }));
  },
});

export const setStage = mutation({
  args: { id: v.id("${table}"), stage },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("${table}", args.id, { stage: args.stage });
    return null;
  },
});
`,
    "src/routes/index.tsx": `import { useMutation, useQuery } from "@grasp-os/sdk/react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { DataGrid } from "@grasp-os/ui/components/data-grid";
import { Grid } from "@grasp-os/ui/components/grid";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { Stat } from "@grasp-os/ui/components/stat";
import { api } from "@server/_generated/api";
import { createFileRoute } from "@tanstack/react-router";

const stages = ${JSON.stringify(stages)} as const;

const Board = () => {
  const counts = useQuery(api.${table}.byStage);
  const setStage = useMutation(api.${table}.setStage);
  return (
    <main className="flex flex-col gap-6 p-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>${title}</PageHeaderTitle>
          <PageHeaderDescription>${intro}</PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>
      <Grid columns={4}>
        {Object.entries(stages).map(([stage, label]) => (
          <Card key={stage} size="sm">
            <CardHeader>
              <CardTitle>{label}</CardTitle>
            </CardHeader>
            <CardContent>
              <Stat variant={stage === "${done}" ? "done" : "default"}>
                {counts === undefined
                  ? "–"
                  : (counts.find((group) => group.stage === stage)?.count ?? 0)}
              </Stat>
            </CardContent>
          </Card>
        ))}
      </Grid>
      <DataGrid
        args={() => ({})}
        columns={[
          ${columns.join(",\n          ")},
        ]}
        label="${title}"
        query={api.${table}.list}
      />
    </main>
  );
};

export const Route = createFileRoute("/")({ component: Board });
`,
  };
};

/** A CSV cell: quoted, its quotes doubled. */
const cell = (value: string): string => `"${value.replaceAll('"', '""')}"`;

/** `board`'s records as the CSV the App's data import reads, and its columns' fields. */
export const boardCsv = ({
  party,
  money,
  records,
}: Board): { csv: string; mapping: Record<string, string> } => {
  const fields = ["title", party, "stage", ...(money ? ["amount"] : [])];
  const rows = records.map(([title, who, stage, euros]) =>
    [
      title,
      who,
      stage,
      ...(money
        ? [JSON.stringify({ currency: "EUR", minorUnits: (euros ?? 0) * 100 })]
        : []),
    ]
      .map(cell)
      .join(",")
  );
  return {
    csv: `${[fields.join(","), ...rows].join("\n")}\n`,
    mapping: Object.fromEntries(fields.map((field) => [field, field])),
  };
};
