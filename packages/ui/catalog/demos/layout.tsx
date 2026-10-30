// Demos of the kit's layout primitives and the direction provider. One per
// component, for the dev-only gallery and its accessibility checks
// (e2e/catalog.e2e.ts).
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { DirectionProvider } from "@grasp-os/ui/components/direction";
import { Grid } from "@grasp-os/ui/components/grid";
import { Inline } from "@grasp-os/ui/components/inline";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { PaintedField } from "@grasp-os/ui/components/painted-field";
import {
  SplitPane,
  SplitPaneAside,
  SplitPaneMain,
} from "@grasp-os/ui/components/split-pane";
import { Stack } from "@grasp-os/ui/components/stack";

const DirectionDemo = () => (
  <DirectionProvider direction="rtl">
    <div dir="rtl" lang="ar">
      <Inline>
        <Button>حفظ</Button>
        <Button variant="outline">إلغاء</Button>
      </Inline>
    </div>
  </DirectionProvider>
);

const stats = [
  { label: "Revenue", value: "€12,400" },
  { label: "Orders", value: "318" },
  { label: "Customers", value: "92" },
];

const GridDemo = () => (
  <Grid columns={3}>
    {stats.map((stat) => (
      <Card key={stat.label}>
        <CardHeader>
          <CardTitle>{stat.label}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xl font-semibold tabular-nums">{stat.value}</p>
        </CardContent>
      </Card>
    ))}
  </Grid>
);

const InlineDemo = () => (
  <Inline>
    <Badge>Design</Badge>
    <Badge variant="secondary">Research</Badge>
    <Badge variant="outline">Q4</Badge>
  </Inline>
);

const PageHeaderDemo = () => (
  <PageHeader>
    <PageHeaderContent>
      <PageHeaderTitle>Customers</PageHeaderTitle>
      <PageHeaderDescription>Everyone you sell to.</PageHeaderDescription>
    </PageHeaderContent>
    <PageHeaderActions>
      <Button variant="outline">Export</Button>
      <Button>Add customer</Button>
    </PageHeaderActions>
  </PageHeader>
);

const SplitPaneDemo = () => (
  <SplitPane>
    <SplitPaneMain>
      <Card>
        <CardContent>
          <p className="text-sm">The order.</p>
        </CardContent>
      </Card>
    </SplitPaneMain>
    <SplitPaneAside aria-label="Customer">
      <Card>
        <CardContent>
          <p className="text-sm">Who ordered it.</p>
        </CardContent>
      </Card>
    </SplitPaneAside>
  </SplitPane>
);

const StackDemo = () => (
  <Stack>
    <Card>
      <CardContent>
        <p className="text-sm">First</p>
      </CardContent>
    </Card>
    <Card>
      <CardContent>
        <p className="text-sm">Second</p>
      </CardContent>
    </Card>
  </Stack>
);

const PaintedFieldDemo = () => (
  <PaintedField
    className="flex h-40 flex-col justify-end gap-1 rounded-xl p-5"
    painting="dawn"
    pattern="columns"
  >
    <p className="type-heading">Three invoices wait on you</p>
    <p className="text-muted-foreground text-sm">
      The oldest came in on Monday.
    </p>
  </PaintedField>
);

export const layoutDemos = {
  "painted-field": PaintedFieldDemo,
  direction: DirectionDemo,
  grid: GridDemo,
  inline: InlineDemo,
  "page-header": PageHeaderDemo,
  "split-pane": SplitPaneDemo,
  stack: StackDemo,
};
