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
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
} from "@grasp-os/ui/components/avatar";
import { Badge } from "@grasp-os/ui/components/badge";
import { BrandIcon } from "@grasp-os/ui/components/brand-icon";
import { Button } from "@grasp-os/ui/components/button";
import {
  ButtonGroup,
  ButtonGroupSeparator,
} from "@grasp-os/ui/components/button-group";
import { Calendar } from "@grasp-os/ui/components/calendar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { Combobox } from "@grasp-os/ui/components/combobox";
import { CopyButton } from "@grasp-os/ui/components/copy-button";
import { DatePicker } from "@grasp-os/ui/components/date-picker";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { FileUpload } from "@grasp-os/ui/components/file-upload";
import { Form, FormFooter, FormSection } from "@grasp-os/ui/components/form";
import { Heading } from "@grasp-os/ui/components/heading";
import { HoldButton } from "@grasp-os/ui/components/hold-button";
import { IconTile } from "@grasp-os/ui/components/icon-tile";
import { ImageUpload } from "@grasp-os/ui/components/image-upload";
import { InlineEdit } from "@grasp-os/ui/components/inline-edit";
import { Input } from "@grasp-os/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@grasp-os/ui/components/input-group";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@grasp-os/ui/components/input-otp";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Kbd, KbdGroup } from "@grasp-os/ui/components/kbd";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import { Label } from "@grasp-os/ui/components/label";
import { Link } from "@grasp-os/ui/components/link";
import { NumberField } from "@grasp-os/ui/components/number-field";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { Progress, ProgressCircle } from "@grasp-os/ui/components/progress";
import {
  RadioGroup,
  RadioGroupItem,
} from "@grasp-os/ui/components/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Separator } from "@grasp-os/ui/components/separator";
import { Shimmer } from "@grasp-os/ui/components/shimmer";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { Slider } from "@grasp-os/ui/components/slider";
import { Snippet } from "@grasp-os/ui/components/snippet";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Stat, StatGroup } from "@grasp-os/ui/components/stat";
import { Switch } from "@grasp-os/ui/components/switch";
import { TagsInput } from "@grasp-os/ui/components/tags-input";
import { Text } from "@grasp-os/ui/components/text";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { ThemeToggle } from "@grasp-os/ui/components/theme-toggle";
import type { ThemeMode } from "@grasp-os/ui/components/theme-toggle";
import { Toggle } from "@grasp-os/ui/components/toggle";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { ArchiveIcon } from "@grasp-os/ui/lib/icons";
import { useState } from "react";

import type { Demos } from "./demo.ts";

// Damsko's form and basic controls, one small use of each, for the local
// gallery (routes/kit_.damsko.tsx) and its journey (e2e/kit-damsko.e2e.ts).

const teams = ["Design", "Engineering", "Sales"];

/** Work that ends at once. */
const work = async (): Promise<void> => {
  await Promise.resolve();
};

const InlineEditDemo = () => {
  const [name, setName] = useState("Quarterly review");
  return (
    <InlineEdit aria-label="Document name" onSubmit={setName} value={name} />
  );
};

const ThemeToggleDemo = () => {
  const [mode, setMode] = useState<ThemeMode>("system");
  return <ThemeToggle mode={mode} onModeChange={setMode} />;
};

export const controlDemos: Demos = {
  accordion: () => (
    <Accordion>
      <AccordionItem value="one">
        <AccordionTrigger>What is kept</AccordionTrigger>
        <AccordionContent>Every document you share.</AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
  alert: () => (
    <Alert>
      <AlertTitle>A new version is ready</AlertTitle>
      <AlertDescription>It opens once your changes are saved.</AlertDescription>
    </Alert>
  ),
  "aspect-ratio": () => (
    <div className="w-40">
      <AspectRatio ratio={16 / 9}>
        <Skeleton />
      </AspectRatio>
    </div>
  ),
  avatar: () => (
    <div className="flex items-center gap-4">
      <Avatar name="Anna de Vries">
        <AvatarFallback>AV</AvatarFallback>
      </Avatar>
      <AvatarGroup
        items={[{ name: "Anna de Vries" }, { name: "Grace Hopper" }]}
      />
    </div>
  ),
  badge: () => <Badge variant="secondary">Draft</Badge>,
  "brand-icon": () => <BrandIcon name="Acme" />,
  button: () => <Button variant="default">Save changes</Button>,
  "button-group": () => (
    <ButtonGroup>
      <Button variant="outline">Back</Button>
      <ButtonGroupSeparator />
      <Button variant="outline">Next</Button>
    </ButtonGroup>
  ),
  calendar: () => <Calendar defaultValue="2026-11-20" />,
  card: () => (
    <Card>
      <CardHeader>
        <CardTitle>Weekly report</CardTitle>
        <CardDescription>Sent every Monday.</CardDescription>
      </CardHeader>
      <CardContent>Three runs last week.</CardContent>
    </Card>
  ),
  checkbox: () => <Checkbox aria-label="Send me the report" defaultChecked />,
  collapsible: () => (
    <Collapsible>
      <CollapsibleTrigger>Details</CollapsibleTrigger>
      <CollapsibleContent>Made on 3 November.</CollapsibleContent>
    </Collapsible>
  ),
  combobox: () => (
    <Combobox aria-label="Team" items={teams} placeholder="Search teams" />
  ),
  "copy-button": () => <CopyButton value="grasp" />,
  "date-picker": () => (
    <DatePicker aria-label="Due date" defaultValue="2026-11-20" name="due" />
  ),
  empty: () => (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>No runs yet</EmptyTitle>
        <EmptyDescription>Runs show here once one starts.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ),
  field: () => (
    <Field name="email">
      <FieldLabel>Email</FieldLabel>
      <Input type="email" />
      <FieldDescription>Where the report goes.</FieldDescription>
    </Field>
  ),
  "file-upload": () => <FileUpload aria-label="Documents" />,
  form: () => (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <FormSection title="Profile">
        <Field name="name">
          <FieldLabel>Name</FieldLabel>
          <Input />
        </Field>
      </FormSection>
      <FormFooter>
        <Button type="submit" variant="default">
          Save
        </Button>
      </FormFooter>
    </Form>
  ),
  heading: () => <Heading level={2}>Settings</Heading>,
  "hold-button": () => <HoldButton onConfirm={work}>Hold to delete</HoldButton>,
  "icon-tile": () => <IconTile icon={ArchiveIcon} />,
  "image-upload": () => <ImageUpload aria-label="Your picture" />,
  "inline-edit": () => <InlineEditDemo />,
  input: () => <Input aria-label="Name" placeholder="Ada Lovelace" />,
  "input-group": () => (
    <InputGroup>
      <InputGroupAddon>
        <InputGroupText>https://</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput aria-label="Address" />
    </InputGroup>
  ),
  "input-otp": () => (
    <InputOTP aria-label="Code" maxLength={4}>
      <InputOTPGroup>
        <InputOTPSlot index={0} />
        <InputOTPSlot index={1} />
        <InputOTPSlot index={2} />
        <InputOTPSlot index={3} />
      </InputOTPGroup>
    </InputOTP>
  ),
  item: () => (
    <ItemGroup>
      <Item>
        <ItemContent>
          <ItemTitle>Invoice intake</ItemTitle>
          <ItemDescription>Runs when an invoice arrives.</ItemDescription>
        </ItemContent>
      </Item>
    </ItemGroup>
  ),
  kbd: () => (
    <KbdGroup>
      <Kbd>⌘</Kbd>
      <Kbd>K</Kbd>
    </KbdGroup>
  ),
  "key-value": () => (
    <KeyValueList
      items={[
        { id: "owner", label: "Owner", value: "Anna de Vries" },
        { id: "created", label: "Created", value: "3 November 2026" },
      ]}
    />
  ),
  label: () => <Label>Workspace name</Label>,
  link: () => <Link href="https://example.com">Read the guide</Link>,
  "number-field": () => <NumberField aria-label="Seats" defaultValue={3} />,
  popover: () => (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">Share</Button>
      </PopoverTrigger>
      <PopoverContent>
        <PopoverHeader>
          <PopoverTitle>Share this page</PopoverTitle>
          <PopoverDescription>
            Anyone on your team can read it.
          </PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  ),
  progress: () => (
    <div className="flex items-center gap-4">
      <Progress aria-label="Uploaded" value={40} />
      <ProgressCircle aria-label="Used" value={70} />
    </div>
  ),
  "radio-group": () => (
    <RadioGroup aria-label="Plan" defaultValue="team">
      <RadioGroupItem aria-label="Team" value="team" />
      <RadioGroupItem aria-label="Company" value="company" />
    </RadioGroup>
  ),
  select: () => (
    <Select defaultValue="small">
      <SelectTrigger aria-label="Model">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="small">Small</SelectItem>
        <SelectItem value="large">Large</SelectItem>
      </SelectContent>
    </Select>
  ),
  separator: () => <Separator />,
  shimmer: () => <Shimmer>Reading the document</Shimmer>,
  skeleton: () => <Skeleton />,
  slider: () => <Slider aria-label="Volume" defaultValue={40} />,
  snippet: () => (
    <Snippet aria-label="Copy the command" value="vp run check:ui" />
  ),
  spinner: () => <Spinner />,
  stat: () => (
    <StatGroup aria-label="This week">
      <Stat label="Runs" value="1,284" />
    </StatGroup>
  ),
  switch: () => <Switch aria-label="Notify me" defaultChecked />,
  "tags-input": () => (
    <TagsInput
      aria-label="Labels"
      defaultValue={["Quarterly", "Finance"]}
      placeholder="Add a label"
    />
  ),
  text: () => <Text>The body of a page, in Geist.</Text>,
  textarea: () => <Textarea aria-label="Note" placeholder="Write a note" />,
  "theme-toggle": () => <ThemeToggleDemo />,
  toggle: () => <Toggle aria-label="Bold">B</Toggle>,
  "toggle-group": () => (
    <ToggleGroup aria-label="View" defaultValue={["list"]}>
      <ToggleGroupItem value="list">List</ToggleGroupItem>
      <ToggleGroupItem value="board">Board</ToggleGroupItem>
    </ToggleGroup>
  ),
  tooltip: () => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline">Hover</Button>
        </TooltipTrigger>
        <TooltipContent>More about this</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
};
