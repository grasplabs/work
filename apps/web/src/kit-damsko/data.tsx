import { AgentIndicator } from "@grasp-os/ui/components/agent-indicator";
import { AudioPlayer } from "@grasp-os/ui/components/audio-player";
import {
  ChartArea,
  ChartContainer,
  ChartGrid,
  ChartTooltip,
  ChartXAxis,
  ChartYAxis,
} from "@grasp-os/ui/components/chart";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@grasp-os/ui/components/code-block";
import { DataGrid } from "@grasp-os/ui/components/data-grid";
import { DataTable } from "@grasp-os/ui/components/data-table";
import { DiffViewer } from "@grasp-os/ui/components/diff-viewer";
import { Markdown } from "@grasp-os/ui/components/markdown";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";

import type { Demos } from "./demo.ts";

// Damsko's data and content components, one small use of each, for the
// local gallery (routes/kit_.damsko.tsx).

const solved = [
  { month: "Jan", solved: 40 },
  { month: "Feb", solved: 46 },
  { month: "Mar", solved: 58 },
];

interface Report {
  id: string;
  name: string;
  pages: number;
}

const reports: Report[] = [
  { id: "q3", name: "Quarterly summary", pages: 12 },
  { id: "risks", name: "Risks", pages: 4 },
];

const code = `const report = await reports.get("q3");`;

export const dataDemos: Demos = {
  "agent-indicator": () => <AgentIndicator aria-label="Filling the column" />,
  "audio-player": () => (
    <AudioPlayer aria-label="A recording" duration={16} src="/favicon.svg" />
  ),
  chart: () => (
    <ChartContainer
      aria-label="Tickets solved by month"
      config={{ solved: { label: "Solved" } }}
      data={solved}
      summary="Up from 40 in January to 58 in March."
      xKey="month"
    >
      <ChartGrid />
      <ChartXAxis />
      <ChartYAxis />
      <ChartArea dataKey="solved" />
      <ChartTooltip />
    </ChartContainer>
  ),
  "code-block": () => (
    <CodeBlock language="ts">
      <CodeBlockHeader>
        <CodeBlockTitle />
        <CodeBlockActions>
          <CodeBlockCopyButton value={code} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent>{code}</CodeBlockContent>
    </CodeBlock>
  ),
  "data-grid": () => (
    <DataGrid
      aria-label="Reports"
      columns={[
        {
          key: "name",
          header: "Report",
          type: "text",
          value: (report) => report.name,
        },
        {
          key: "pages",
          header: "Pages",
          type: "number",
          value: (report) => report.pages,
        },
      ]}
      getRowId={(report) => report.id}
      rows={reports}
    />
  ),
  "data-table": () => (
    <DataTable
      aria-label="Reports"
      columns={[
        { id: "name", header: "Report", value: (report) => report.name },
        { id: "pages", header: "Pages", value: (report) => report.pages },
      ]}
      getRowId={(report) => report.id}
      rows={reports}
      unit={{ one: "report", other: "reports" }}
    />
  ),
  "diff-viewer": () => (
    <DiffViewer
      newValue={"Sent every Monday.\nThree runs last week."}
      oldValue={"Sent every Friday.\nThree runs last week."}
      title="report.md"
    />
  ),
  markdown: () => (
    <Markdown>
      {
        "## Summary\n\nTwelve people commented on the **quarterly summary**.\n\n- Most agree\n- Two points need an answer"
      }
    </Markdown>
  ),
  table: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Workflow</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>Weekly report</TableCell>
          <TableCell>Succeeded</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};
