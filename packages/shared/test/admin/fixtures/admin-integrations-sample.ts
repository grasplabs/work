import type { AskedApp } from "../../../src/admin/admin-integrations.ts";

/** Apps the sample companies asked Grasp to add, as their cores said it. */
export const SAMPLE_ASKED: AskedApp[] = [
  {
    id: "asked-1",
    app: "Exact Online",
    requests: [
      { org: "noordkade", on: "2026-09-02" },
      { org: "hartog", on: "2026-09-10" },
      { org: "veldkamp", on: "2026-09-21" },
    ],
  },
  {
    id: "asked-2",
    app: "Syntess Atrium",
    requests: [{ org: "veldkamp", on: "2026-09-15" }],
  },
  {
    id: "asked-3",
    app: "Twinfield",
    requests: [{ org: "vanrijn", on: "2026-10-01" }],
  },
];
