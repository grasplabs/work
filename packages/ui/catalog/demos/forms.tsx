// Demos of the kit's buttons and form controls, one per component, for the
// dev-only gallery and its accessibility checks (e2e/catalog.e2e.ts). Every
// control has a name.
import { Button } from "@grasp-os/ui/components/button";
import {
  ButtonGroup,
  ButtonGroupSeparator,
  ButtonGroupText,
} from "@grasp-os/ui/components/button-group";
import { Calendar } from "@grasp-os/ui/components/calendar";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@grasp-os/ui/components/combobox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@grasp-os/ui/components/input-otp";
import { Label } from "@grasp-os/ui/components/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
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
import { Slider } from "@grasp-os/ui/components/slider";
import { Switch } from "@grasp-os/ui/components/switch";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Toggle } from "@grasp-os/ui/components/toggle";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import {
  BoldIcon,
  CopyIcon,
  ItalicIcon,
  SearchIcon,
  UnderlineIcon,
} from "lucide-react";

const ButtonDemo = () => (
  <div className="flex flex-wrap gap-2">
    <Button>Save</Button>
    <Button variant="outline">Cancel</Button>
    <Button variant="ghost" size="icon" aria-label="Copy">
      <CopyIcon />
    </Button>
  </div>
);

const ButtonGroupDemo = () => (
  <ButtonGroup>
    <ButtonGroupText>Sort</ButtonGroupText>
    <Button variant="outline">Newest</Button>
    <ButtonGroupSeparator />
    <Button variant="outline">Oldest</Button>
  </ButtonGroup>
);

const CalendarDemo = () => (
  <Calendar mode="single" defaultMonth={new Date(2026, 9, 1)} />
);

const CheckboxDemo = () => (
  <Field orientation="horizontal">
    <Checkbox id="demo-terms" />
    <FieldLabel htmlFor="demo-terms">Accept the terms</FieldLabel>
  </Field>
);

const frameworks = ["Astro", "Next.js", "Remix", "SvelteKit"];

const ComboboxDemo = () => (
  <Combobox items={frameworks}>
    <ComboboxInput aria-label="Framework" placeholder="Pick a framework" />
    <ComboboxContent>
      <ComboboxEmpty>No framework found.</ComboboxEmpty>
      <ComboboxList>
        {(item: string) => (
          <ComboboxItem key={item} value={item}>
            {item}
          </ComboboxItem>
        )}
      </ComboboxList>
    </ComboboxContent>
  </Combobox>
);

const FieldDemo = () => (
  <FieldGroup>
    <Field>
      <FieldLabel htmlFor="demo-field-name">Name</FieldLabel>
      <Input id="demo-field-name" />
      <FieldDescription>As it appears on invoices.</FieldDescription>
    </Field>
  </FieldGroup>
);

const InputDemo = () => (
  <Input aria-label="Email" type="email" placeholder="name@example.com" />
);

const InputGroupDemo = () => (
  <InputGroup>
    <InputGroupAddon>
      <SearchIcon />
    </InputGroupAddon>
    <InputGroupInput aria-label="Search" placeholder="Search" />
    <InputGroupAddon align="inline-end">
      <InputGroupButton>Go</InputGroupButton>
    </InputGroupAddon>
  </InputGroup>
);

const InputOtpDemo = () => (
  <InputOTP maxLength={6} aria-label="Verification code">
    <InputOTPGroup>
      <InputOTPSlot index={0} />
      <InputOTPSlot index={1} />
      <InputOTPSlot index={2} />
    </InputOTPGroup>
    <InputOTPSeparator />
    <InputOTPGroup>
      <InputOTPSlot index={3} />
      <InputOTPSlot index={4} />
      <InputOTPSlot index={5} />
    </InputOTPGroup>
  </InputOTP>
);

const LabelDemo = () => (
  <div className="flex flex-col gap-2">
    <Label htmlFor="demo-label-input">Company</Label>
    <Input id="demo-label-input" />
  </div>
);

const NativeSelectDemo = () => (
  <NativeSelect aria-label="Country" defaultValue="nl">
    <NativeSelectOption value="nl">Netherlands</NativeSelectOption>
    <NativeSelectOption value="be">Belgium</NativeSelectOption>
    <NativeSelectOption value="de">Germany</NativeSelectOption>
  </NativeSelect>
);

const RadioGroupDemo = () => (
  <RadioGroup defaultValue="monthly" aria-label="Billing">
    <Field orientation="horizontal">
      <RadioGroupItem value="monthly" id="demo-monthly" />
      <FieldLabel htmlFor="demo-monthly">Monthly</FieldLabel>
    </Field>
    <Field orientation="horizontal">
      <RadioGroupItem value="yearly" id="demo-yearly" />
      <FieldLabel htmlFor="demo-yearly">Yearly</FieldLabel>
    </Field>
  </RadioGroup>
);

const models = [
  { value: "small", label: "Small" },
  { value: "large", label: "Large" },
];

const SelectDemo = () => (
  <Select items={models} defaultValue="small">
    <SelectTrigger aria-label="Model">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {models.map((model) => (
        <SelectItem key={model.value} value={model.value}>
          {model.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

const SliderDemo = () => (
  <Field>
    <FieldLabel id="demo-volume">Volume</FieldLabel>
    <Slider defaultValue={[40]} aria-labelledby="demo-volume" />
  </Field>
);

const SwitchDemo = () => (
  <Field orientation="horizontal">
    <Switch id="demo-switch" />
    <FieldLabel htmlFor="demo-switch">Notifications</FieldLabel>
  </Field>
);

const TextareaDemo = () => (
  <Textarea aria-label="Notes" placeholder="Anything else?" />
);

const ToggleDemo = () => (
  <Toggle aria-label="Bold">
    <BoldIcon />
  </Toggle>
);

const ToggleGroupDemo = () => (
  <ToggleGroup defaultValue={["bold"]} aria-label="Text style">
    <ToggleGroupItem value="bold" aria-label="Bold">
      <BoldIcon />
    </ToggleGroupItem>
    <ToggleGroupItem value="italic" aria-label="Italic">
      <ItalicIcon />
    </ToggleGroupItem>
    <ToggleGroupItem value="underline" aria-label="Underline">
      <UnderlineIcon />
    </ToggleGroupItem>
  </ToggleGroup>
);

export const formDemos = {
  button: ButtonDemo,
  "button-group": ButtonGroupDemo,
  calendar: CalendarDemo,
  checkbox: CheckboxDemo,
  combobox: ComboboxDemo,
  field: FieldDemo,
  input: InputDemo,
  "input-group": InputGroupDemo,
  "input-otp": InputOtpDemo,
  label: LabelDemo,
  "native-select": NativeSelectDemo,
  "radio-group": RadioGroupDemo,
  select: SelectDemo,
  slider: SliderDemo,
  switch: SwitchDemo,
  textarea: TextareaDemo,
  toggle: ToggleDemo,
  "toggle-group": ToggleGroupDemo,
};
