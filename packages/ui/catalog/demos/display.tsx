// Demos of the kit's components that show content: status, media, data and
// structure. One per component, for the dev-only gallery and its
// accessibility checks (e2e/catalog.e2e.ts).
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@grasp-os/ui/components/accordion";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { AspectRatio } from "@grasp-os/ui/components/aspect-ratio";
import { AutoHeight, FadeIn } from "@grasp-os/ui/components/auto-height";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
} from "@grasp-os/ui/components/avatar";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardRow,
  CardRowControl,
  CardRowLabel,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@grasp-os/ui/components/carousel";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  XAxis,
  chartColor,
} from "@grasp-os/ui/components/chart";
import type { ChartConfig } from "@grasp-os/ui/components/chart";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { GraspMark } from "@grasp-os/ui/components/grasp-mark";
import { Input } from "@grasp-os/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Kbd, KbdGroup } from "@grasp-os/ui/components/kbd";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@grasp-os/ui/components/progress";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@grasp-os/ui/components/resizable";
import { ScrollArea } from "@grasp-os/ui/components/scroll-area";
import { Separator } from "@grasp-os/ui/components/separator";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Stat } from "@grasp-os/ui/components/stat";
import { SuccessMark } from "@grasp-os/ui/components/success-mark";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import {
  Tile,
  TileContent,
  TileDescription,
  TileField,
  TileMeta,
  TileSheet,
  TileSheetBar,
  TileTitle,
} from "@grasp-os/ui/components/tile";
import {
  ChevronRightIcon,
  CogIcon,
  InfoIcon,
  LayoutGridIcon,
} from "lucide-react";

const AccordionDemo = () => (
  <Accordion defaultValue={["shipping"]}>
    <AccordionItem value="shipping">
      <AccordionTrigger>Shipping</AccordionTrigger>
      <AccordionContent>Orders ship within two working days.</AccordionContent>
    </AccordionItem>
    <AccordionItem value="returns">
      <AccordionTrigger>Returns</AccordionTrigger>
      <AccordionContent>Return anything within 30 days.</AccordionContent>
    </AccordionItem>
  </Accordion>
);

const AlertDemo = () => (
  <Alert>
    <InfoIcon />
    <AlertTitle>Scheduled maintenance</AlertTitle>
    <AlertDescription>
      The app is read-only on Sunday from 2:00.
    </AlertDescription>
  </Alert>
);

const AspectRatioDemo = () => (
  <AspectRatio ratio="video">
    <div className="bg-muted text-muted-foreground flex size-full items-center justify-center rounded-lg text-sm">
      16 by 9
    </div>
  </AspectRatio>
);

const AvatarDemo = () => (
  <AvatarGroup>
    <Avatar>
      <AvatarFallback>MJ</AvatarFallback>
    </Avatar>
    <Avatar>
      <AvatarFallback>TB</AvatarFallback>
    </Avatar>
  </AvatarGroup>
);

const BadgeDemo = () => (
  <div className="flex flex-wrap gap-2">
    <Badge>New</Badge>
    <Badge variant="secondary">Draft</Badge>
    <Badge variant="destructive">Overdue</Badge>
  </div>
);

const CardDemo = () => (
  <div className="flex flex-col gap-6">
    <Card>
      <CardHeader>
        <CardTitle>Revenue</CardTitle>
        <CardDescription>This month so far.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tabular-nums">€12,400</p>
      </CardContent>
    </Card>
    <Card variant="panel">
      <CardHeader>
        <CardTitle>Sign-in</CardTitle>
        <CardDescription>How people at Acme sign in.</CardDescription>
        <CardAction>
          <Button size="sm" variant="outline">
            Save
          </Button>
        </CardAction>
      </CardHeader>
      <CardRow>
        <CardRowLabel>
          <span>Provider</span>
          <p className="text-muted-foreground">Where accounts live.</p>
        </CardRowLabel>
        <CardRowControl>Microsoft 365</CardRowControl>
      </CardRow>
      <CardContent>
        <p>Everyone signs in with their work account.</p>
      </CardContent>
    </Card>
  </div>
);

const slides = ["First", "Second", "Third"];

const CarouselDemo = () => (
  <div className="flex flex-col gap-6">
    {/* Room for the buttons, which sit outside the slides. */}
    <div className="px-12">
      <Carousel>
        <CarouselContent>
          {slides.map((slide) => (
            <CarouselItem key={slide}>
              <Card>
                <CardContent>
                  <div className="flex h-32 flex-col items-center justify-center gap-2">
                    <p className="text-lg">{slide} slide</p>
                    {/* The arrow keys move the cursor here, not the slide. */}
                    <Input
                      aria-label={`${slide} slide note`}
                      defaultValue="Note"
                    />
                  </div>
                </CardContent>
              </Card>
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious />
        <CarouselNext />
      </Carousel>
    </div>
    {/* Vertical: up and down move between the slides. */}
    <div className="py-12">
      <Carousel orientation="vertical" opts={{ align: "start" }}>
        <CarouselContent className="h-40">
          {slides.map((slide) => (
            <CarouselItem key={slide} className="basis-1/2">
              <Card>
                <CardContent>
                  <p className="text-sm">{slide} card</p>
                </CardContent>
              </Card>
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious label="Previous card" />
        <CarouselNext label="Next card" />
      </Carousel>
    </div>
  </div>
);

const visits = [
  { month: "May", visits: 186 },
  { month: "June", visits: 305 },
  { month: "July", visits: 237 },
  { month: "August", visits: 273 },
];

const chartConfig = {
  visits: { label: "Visits", color: "chart-1" },
} satisfies ChartConfig;

const ChartDemo = () => (
  <ChartContainer config={chartConfig} className="min-h-48 w-full">
    <BarChart data={visits} accessibilityLayer>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="month" tickLine={false} axisLine={false} />
      <ChartTooltip content={<ChartTooltipContent />} />
      <Bar dataKey="visits" fill={chartColor("chart-1")} radius={4} />
    </BarChart>
  </ChartContainer>
);

const CollapsibleDemo = () => (
  <Collapsible>
    <CollapsibleTrigger render={<Button variant="outline" />}>
      Show the details
    </CollapsibleTrigger>
    <CollapsibleContent>
      <p className="pt-2 text-sm">Created by Maya on 3 October.</p>
    </CollapsibleContent>
  </Collapsible>
);

const EmptyDemo = () => (
  <Empty>
    <EmptyHeader>
      <EmptyTitle>No projects yet</EmptyTitle>
      <EmptyDescription>Projects you create show up here.</EmptyDescription>
    </EmptyHeader>
  </Empty>
);

const ItemDemo = () => (
  <div className="flex flex-col gap-6">
    <Item variant="outline">
      <ItemContent>
        <ItemTitle>Weekly report</ItemTitle>
        <ItemDescription>Every Monday at 9:00.</ItemDescription>
      </ItemContent>
    </Item>
    {/* Questions to start from: buttons in a named list. */}
    <ItemGroup
      aria-label="Questions to start with"
      render={<ul />}
      spacing="tight"
    >
      <li>
        <Item
          render={
            <button
              aria-label="Where does the most time still go?"
              type="button"
            />
          }
          size="sm"
          variant="quiet"
        >
          Where does the most time still go?
        </Item>
      </li>
    </ItemGroup>
    <ItemGroup
      aria-label="Questions to start from"
      render={<ul />}
      variant="card"
    >
      <li>
        <Item
          render={<button aria-label="Who needs Grasp today?" type="button" />}
          size="sm"
          variant="row"
        >
          <ItemContent>Who needs Grasp today?</ItemContent>
          <ItemActions>
            <ChevronRightIcon aria-hidden="true" />
          </ItemActions>
        </Item>
      </li>
    </ItemGroup>
  </div>
);

const TileDemo = () => (
  <Tile className="max-w-sm">
    <TileField painting="dawn" pattern="columns">
      <Badge variant="passed">Published</Badge>
      <TileSheet>
        <TileSheetBar icon={<LayoutGridIcon />}>Board</TileSheetBar>
      </TileSheet>
    </TileField>
    <TileContent>
      <TileTitle href="#board">Board</TileTitle>
      <TileDescription>
        Every open lead, from first call to contract.
      </TileDescription>
      <TileMeta>
        <CogIcon aria-hidden="true" />
        Sales pipeline
      </TileMeta>
    </TileContent>
  </Tile>
);

const KbdDemo = () => (
  <p className="text-sm">
    Search with{" "}
    <KbdGroup>
      <Kbd>Ctrl</Kbd>
      <Kbd>K</Kbd>
    </KbdGroup>
  </p>
);

const ProgressDemo = () => (
  <Progress value={60}>
    <ProgressLabel>Upload</ProgressLabel>
    <ProgressValue />
  </Progress>
);

const ResizableDemo = () => (
  <div className="h-32 overflow-hidden rounded-lg border">
    <ResizablePanelGroup>
      <ResizablePanel defaultSize="40%">
        <div className="p-4 text-sm">List</div>
      </ResizablePanel>
      <ResizableHandle withHandle aria-label="Resize the list" />
      <ResizablePanel defaultSize="60%">
        <div className="p-4 text-sm">Details</div>
      </ResizablePanel>
    </ResizablePanelGroup>
  </div>
);

const tags = Array.from({ length: 30 }, (_, index) => `Tag ${index + 1}`);

const ScrollAreaDemo = () => (
  <div className="overflow-hidden rounded-lg border">
    <ScrollArea className="h-48">
      <ul className="flex flex-col gap-2 p-4 text-sm">
        {tags.map((tag) => (
          <li key={tag}>{tag}</li>
        ))}
      </ul>
    </ScrollArea>
  </div>
);

const SeparatorDemo = () => (
  <div className="flex flex-col gap-2 text-sm">
    <span>Above</span>
    <Separator />
    <span>Below</span>
  </div>
);

const SkeletonDemo = () => (
  <div className="flex flex-col gap-2">
    <Skeleton className="h-4 w-48" />
    <Skeleton className="h-4 w-32" />
  </div>
);

const SpinnerDemo = () => <Spinner />;

const TableDemo = () => (
  <Table>
    <TableCaption>Recent runs</TableCaption>
    <TableHeader>
      <TableRow>
        <TableHead>Workflow</TableHead>
        <TableHead>Status</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow>
        <TableCell>Weekly report</TableCell>
        <TableCell>Done</TableCell>
      </TableRow>
    </TableBody>
  </Table>
);

const AutoHeightDemo = () => (
  <AutoHeight>
    <FadeIn>
      <div className="flex flex-col gap-1">
        <p className="font-medium">Sign in</p>
        <p className="text-muted-foreground">
          Signing in happens at Microsoft 365. It takes about a minute.
        </p>
      </div>
    </FadeIn>
  </AutoHeight>
);

const SuccessMarkDemo = () => (
  <div className="flex flex-col items-center gap-4 text-center">
    <SuccessMark />
    <p className="font-medium">Microsoft 365 is connected</p>
  </div>
);

const StatDemo = () => (
  <dl className="flex gap-8">
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-sm">Hours handed back</dt>
      <Stat render={<dd />}>1,284</Stat>
    </div>
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-sm">Waiting on you</dt>
      <Stat render={<dd />} variant="attention">
        3
      </Stat>
    </div>
  </dl>
);

const GraspMarkDemo = () => (
  <div className="flex items-center gap-2">
    <GraspMark className="size-6" />
    <span className="font-medium">Grasp</span>
  </div>
);

export const displayDemos = {
  accordion: AccordionDemo,
  alert: AlertDemo,
  "aspect-ratio": AspectRatioDemo,
  "auto-height": AutoHeightDemo,
  avatar: AvatarDemo,
  badge: BadgeDemo,
  card: CardDemo,
  carousel: CarouselDemo,
  chart: ChartDemo,
  collapsible: CollapsibleDemo,
  empty: EmptyDemo,
  "grasp-mark": GraspMarkDemo,
  stat: StatDemo,
  item: ItemDemo,
  kbd: KbdDemo,
  progress: ProgressDemo,
  resizable: ResizableDemo,
  "scroll-area": ScrollAreaDemo,
  "success-mark": SuccessMarkDemo,
  separator: SeparatorDemo,
  skeleton: SkeletonDemo,
  spinner: SpinnerDemo,
  table: TableDemo,
  tile: TileDemo,
};
