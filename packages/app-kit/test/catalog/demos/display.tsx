// Demos of the kit's components that show content: status, media, data and
// structure. One per component, for the kit's accessibility checks
// (test/kit.browser.test.tsx).
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@grasp-os/app-kit/components/accordion";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/app-kit/components/alert";
import { AspectRatio } from "@grasp-os/app-kit/components/aspect-ratio";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
} from "@grasp-os/app-kit/components/avatar";
import { Badge } from "@grasp-os/app-kit/components/badge";
import { Button } from "@grasp-os/app-kit/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@grasp-os/app-kit/components/card";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@grasp-os/app-kit/components/carousel";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@grasp-os/app-kit/components/chart";
import type { ChartConfig } from "@grasp-os/app-kit/components/chart";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/app-kit/components/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/app-kit/components/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/app-kit/components/item";
import { Kbd, KbdGroup } from "@grasp-os/app-kit/components/kbd";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@grasp-os/app-kit/components/progress";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@grasp-os/app-kit/components/resizable";
import { RichText } from "@grasp-os/app-kit/components/rich-text";
import { ScrollArea } from "@grasp-os/app-kit/components/scroll-area";
import { Separator } from "@grasp-os/app-kit/components/separator";
import { Skeleton } from "@grasp-os/app-kit/components/skeleton";
import { Spinner } from "@grasp-os/app-kit/components/spinner";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/app-kit/components/table";
import { ChevronRightIcon, InfoIcon } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";

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
  <AspectRatio ratio={16 / 9}>
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
    <Card size="sm">
      <CardHeader>
        <CardTitle>Sign-in</CardTitle>
        <CardDescription>How people at Acme sign in.</CardDescription>
        <CardAction>
          <Button size="sm" variant="outline">
            Edit
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p>Everyone signs in with their work account.</p>
      </CardContent>
      <CardFooter>
        <Button size="sm">Save</Button>
      </CardFooter>
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
                  <div className="flex h-32 items-center justify-center">
                    <p className="text-lg">{slide} slide</p>
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
        <CarouselPrevious />
        <CarouselNext />
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
  visits: { label: "Visits", color: "var(--chart-1)" },
} satisfies ChartConfig;

const ChartDemo = () => (
  <ChartContainer config={chartConfig} className="min-h-48 w-full">
    <BarChart data={visits} accessibilityLayer>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="month" tickLine={false} axisLine={false} />
      <ChartTooltip content={<ChartTooltipContent />} />
      <Bar dataKey="visits" fill="var(--color-visits)" radius={4} />
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
    {/* A link, as a row that opens a record. */}
    <Item render={<a aria-label="Invoice desk" href="#app" />} size="sm">
      <ItemMedia variant="icon">
        <InfoIcon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Invoice desk</ItemTitle>
        <ItemDescription>Unpublished changes</ItemDescription>
      </ItemContent>
      <ItemActions>
        <ChevronRightIcon aria-hidden="true" />
      </ItemActions>
    </Item>
    <ItemGroup aria-label="Recent reports">
      <Item variant="muted">
        <ItemContent>
          <ItemTitle>October</ItemTitle>
        </ItemContent>
      </Item>
      <Item variant="muted">
        <ItemContent>
          <ItemTitle>September</ItemTitle>
        </ItemContent>
      </Item>
    </ItemGroup>
  </div>
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

const RichTextDemo = () => (
  <RichText
    value={
      "**Ship** the *plan* this week:\n\n- Draft it\n- [Review it](https://example.com)\n\n<b>Raw HTML</b> is dropped."
    }
  />
);

export const displayDemos = {
  accordion: AccordionDemo,
  alert: AlertDemo,
  "aspect-ratio": AspectRatioDemo,
  avatar: AvatarDemo,
  badge: BadgeDemo,
  card: CardDemo,
  carousel: CarouselDemo,
  chart: ChartDemo,
  collapsible: CollapsibleDemo,
  empty: EmptyDemo,
  item: ItemDemo,
  kbd: KbdDemo,
  progress: ProgressDemo,
  resizable: ResizableDemo,
  "scroll-area": ScrollAreaDemo,
  separator: SeparatorDemo,
  skeleton: SkeletonDemo,
  spinner: SpinnerDemo,
  table: TableDemo,
  "rich-text": RichTextDemo,
};
