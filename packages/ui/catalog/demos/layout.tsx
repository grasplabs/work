// Demos of the kit's layout primitives and the direction provider. One per
// component, for the dev-only gallery and its accessibility checks
// (test/kit.browser.test.tsx).
import {
  AppShell,
  AppShellContent,
  AppShellDock,
  AppShellMain,
} from "@grasp-os/ui/components/app-shell";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { DirectionProvider } from "@grasp-os/ui/components/direction";
import {
  DockablePanel,
  DockablePanelHandle,
  DockablePanelHeader,
} from "@grasp-os/ui/components/dockable-panel";
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
import { Panel } from "@grasp-os/ui/components/panel";
import type { PanelSide } from "@grasp-os/ui/components/panel";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@grasp-os/ui/components/sidebar";
import {
  SplitPane,
  SplitPaneAside,
  SplitPaneMain,
} from "@grasp-os/ui/components/split-pane";
import { Stack } from "@grasp-os/ui/components/stack";
import { useState } from "react";

const AppShellDemo = () => {
  const [open, setOpen] = useState(false);
  return (
    <div className="h-96 overflow-hidden rounded-lg border">
      <AppShell className="h-full min-h-0">
        <Sidebar collapsible="none" variant="inset">
          <SidebarContent>
            <SidebarGroup>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton isActive>Home</SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton>Projects</SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <AppShellMain>
          {/* The catalog's own page is the document's main already. */}
          <AppShellContent render={<div />}>
            <div className="p-6">
              <p>The page, in its card.</p>
            </div>
          </AppShellContent>
          <AppShellDock>
            <Button
              onClick={() => {
                setOpen(!open);
              }}
              variant="outline"
            >
              {open ? "Close the panel" : "Open the panel"}
            </Button>
          </AppShellDock>
        </AppShellMain>
        <Panel open={open} side="right" size={240}>
          <div className="w-60 p-6">
            <p>Beside the page.</p>
          </div>
        </Panel>
      </AppShell>
    </div>
  );
};

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

const DockablePanelDemo = () => {
  const [shown, setShown] = useState(false);
  return (
    <>
      <Button
        onClick={() => {
          setShown(!shown);
        }}
        variant="outline"
      >
        {shown ? "Hide the floating panel" : "Show the floating panel"}
      </Button>
      <DockablePanel label="Notes" open={shown} placement="floating">
        <DockablePanelHeader>
          <DockablePanelHandle label="Move the notes" />
          <span className="font-medium">Notes</span>
        </DockablePanelHeader>
        <div className="p-4">
          <p>Drag the header to move it anywhere.</p>
        </div>
      </DockablePanel>
    </>
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
  <PaintedField className="h-40" painting="dawn" pattern="columns">
    <div className="flex h-full flex-col justify-end gap-1 p-5">
      <p className="type-display">Three invoices wait on you</p>
      <p className="text-muted-foreground text-sm">
        The oldest came in on Monday.
      </p>
    </div>
  </PaintedField>
);

export const layoutDemos = {
  "app-shell": AppShellDemo,
  "painted-field": PaintedFieldDemo,
  panel: PanelDemo,
  direction: DirectionDemo,
  "dockable-panel": DockablePanelDemo,
  grid: GridDemo,
  inline: InlineDemo,
  "page-header": PageHeaderDemo,
  "split-pane": SplitPaneDemo,
  stack: StackDemo,
};
