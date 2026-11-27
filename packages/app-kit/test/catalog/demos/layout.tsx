// Demos of the kit's layout primitives and the direction provider. One per
// component, for the kit's accessibility checks (test/kit.browser.test.tsx).
import { Badge } from "@grasp-os/app-kit/components/badge";
import { Button } from "@grasp-os/app-kit/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/app-kit/components/card";
import { DirectionProvider } from "@grasp-os/app-kit/components/direction";
import { Grid } from "@grasp-os/app-kit/components/grid";
import { Inline } from "@grasp-os/app-kit/components/inline";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/app-kit/components/page-header";
import { Panel } from "@grasp-os/app-kit/components/panel";
import type { PanelSide } from "@grasp-os/app-kit/components/panel";
import { Stack } from "@grasp-os/app-kit/components/stack";
import { useState } from "react";

/** A panel on each edge of a box, each opened and collapsed on its own. */
const PanelDemo = () => {
  const [open, setOpen] = useState<Record<PanelSide, boolean>>({
    top: true,
    right: false,
    bottom: false,
    left: true,
  });
  const [rightSize, setRightSize] = useState(192);
  const sides: PanelSide[] = ["top", "right", "bottom", "left"];
  return (
    <Stack>
      <Inline>
        {sides.map((side) => (
          <Button
            key={side}
            onClick={() => {
              setOpen({ ...open, [side]: !open[side] });
            }}
            variant="outline"
          >
            {open[side] ? `Collapse ${side}` : `Open ${side}`}
          </Button>
        ))}
      </Inline>
      <div className="flex h-80 flex-col overflow-hidden rounded-lg border">
        <Panel bordered open={open.top} side="top" size={64}>
          <p className="p-4">Top</p>
        </Panel>
        <div className="flex min-h-0 flex-1">
          <Panel
            bordered
            collapsedSize={48}
            open={open.left}
            side="left"
            size={192}
          >
            <p className="w-48 p-4">Left, with a rail</p>
          </Panel>
          <div className="flex-1 p-4">The content</div>
          <Panel
            bordered
            maxSize={320}
            minSize={160}
            onSizeChange={setRightSize}
            open={open.right}
            resizeLabel="Resize the right panel"
            side="right"
            size={rightSize}
          >
            <p className="w-48 p-4">Right, resizable</p>
          </Panel>
        </div>
        <Panel bordered open={open.bottom} side="bottom" size={64}>
          <p className="p-4">Bottom</p>
        </Panel>
      </div>
    </Stack>
  );
};

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

export const layoutDemos = {
  panel: PanelDemo,
  direction: DirectionDemo,
  grid: GridDemo,
  inline: InlineDemo,
  "page-header": PageHeaderDemo,
  stack: StackDemo,
};
