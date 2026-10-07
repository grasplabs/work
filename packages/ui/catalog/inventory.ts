/**
 * The kit's inventory: every component of the shadcn catalog, by its
 * registry name, mapped to the kit's module of the same name or to why the
 * kit has none, and the kit's own components on top. Agents read it to
 * learn what screens can import; test/catalog.test.ts holds it to what the
 * components directory exports, so it can't claim more than is there.
 *
 * Every module is imported as `@grasp-os/ui/components/<name>`.
 *
 * It lives outside `src` on purpose: every source in `src` is built into
 * the kit's modules that screens load (packages/compiler/build.ts), and the
 * inventory is for agents, not for screens.
 */

/**
 * The shadcn registry the inventory was taken from: the Base UI variant of
 * the catalog, at one revision. When upstream adds a component, add it here
 * (`planned` until the kit has it) and move the pin.
 */
export const shadcnRegistry = {
  style: "base-vega",
  url: "https://ui.shadcn.com/r/styles/base-vega/registry.json",
  lastModified: "2026-10-07T13:57:52Z",
  etag: "cecb1bec1b9c06bff1a3caebd2db98a7",
  cli: "shadcn@4.21.0",
} as const;

/** In the kit: the module exports exactly `exports`, its runtime values. */
export interface SupportedEntry {
  status: "supported";
  /** What it is for, in a line. */
  summary: string;
  exports: readonly string[];
  /** Where the kit's version differs from shadcn's, and why. */
  changes?: string;
}

/** Not in the kit yet; it will be. */
export interface PlannedEntry {
  status: "planned";
}

/** Not in the kit, on purpose. */
export interface UnsupportedEntry {
  status: "unsupported";
  reason: string;
  /** The kit's component to use instead. */
  instead?: string;
}

export type CatalogEntry = SupportedEntry | PlannedEntry | UnsupportedEntry;

export const shadcnComponents = {
  accordion: {
    status: "supported",
    summary: "Stacked headings that each show or hide a section.",
    exports: [
      "Accordion",
      "AccordionContent",
      "AccordionItem",
      "AccordionTrigger",
    ],
  },
  alert: {
    status: "supported",
    summary: "A callout for a message that needs attention, inline.",
    exports: ["Alert", "AlertAction", "AlertDescription", "AlertTitle"],
  },
  "alert-dialog": {
    status: "supported",
    summary: "A modal that interrupts to confirm an action, such as a delete.",
    exports: [
      "AlertDialog",
      "AlertDialogAction",
      "AlertDialogCancel",
      "AlertDialogContent",
      "AlertDialogDescription",
      "AlertDialogFooter",
      "AlertDialogHeader",
      "AlertDialogMedia",
      "AlertDialogOverlay",
      "AlertDialogPortal",
      "AlertDialogTitle",
      "AlertDialogTrigger",
    ],
    changes:
      "The overlay dims the page with the theme's `scrim` token instead of raw black.",
  },
  "aspect-ratio": {
    status: "supported",
    summary: "Keeps media, such as an image or a video, at a ratio.",
    exports: ["AspectRatio", "aspectRatioVariants"],
    changes:
      "`ratio` is one of a set of named ratios, each a static class, instead of any number in an inline style.",
  },
  attachment: {
    status: "supported",
    summary:
      "A file attached to a message or a form, with its name and actions.",
    exports: [
      "Attachment",
      "AttachmentAction",
      "AttachmentActions",
      "AttachmentContent",
      "AttachmentDescription",
      "AttachmentGroup",
      "AttachmentMedia",
      "AttachmentTitle",
      "AttachmentTrigger",
    ],
  },
  avatar: {
    status: "supported",
    summary: "A person's picture, or their initials when there is none.",
    exports: [
      "Avatar",
      "AvatarBadge",
      "AvatarFallback",
      "AvatarGroup",
      "AvatarGroupCount",
      "AvatarImage",
    ],
  },
  badge: {
    status: "supported",
    summary: "A small label for a status or a count.",
    exports: ["Badge", "badgeVariants"],
  },
  breadcrumb: {
    status: "supported",
    summary: "The path to the current page, as links.",
    exports: [
      "Breadcrumb",
      "BreadcrumbEllipsis",
      "BreadcrumbItem",
      "BreadcrumbLink",
      "BreadcrumbList",
      "BreadcrumbPage",
      "BreadcrumbSeparator",
    ],
  },
  bubble: {
    status: "supported",
    summary: "A chat message's bubble, with reactions.",
    exports: ["Bubble", "BubbleContent", "BubbleGroup", "BubbleReactions"],
  },
  button: {
    status: "supported",
    summary: "A button, or a link that looks like one.",
    exports: ["Button", "buttonVariants"],
    changes: "Adds the `ask` variant and the `xl` size Grasp's own pages use.",
  },
  "button-group": {
    status: "supported",
    summary: "Buttons joined into one control.",
    exports: [
      "ButtonGroup",
      "ButtonGroupSeparator",
      "ButtonGroupText",
      "buttonGroupVariants",
    ],
  },
  calendar: {
    status: "supported",
    summary: "A month grid to pick a date or a range.",
    exports: ["Calendar", "CalendarDayButton"],
    changes:
      "The day picker's parts are components of their own instead of defined during render, and a focused day takes keyboard focus (upstream never attached the ref).",
  },
  card: {
    status: "supported",
    summary: "A bordered box with a header, content and footer.",
    exports: [
      "Card",
      "CardAction",
      "CardContent",
      "CardDescription",
      "CardFooter",
      "CardHeader",
      "CardTitle",
    ],
  },
  carousel: {
    status: "supported",
    summary: "Slides that scroll one by one, with previous and next buttons.",
    exports: [
      "Carousel",
      "CarouselContent",
      "CarouselItem",
      "CarouselNext",
      "CarouselPrevious",
      "useCarousel",
    ],
    changes:
      "Reads whether it can scroll from the carousel as it changes, instead of copying it into state from an effect; `label` names the previous and next buttons, for translations. The arrow keys leave fields inside the slides alone, follow the orientation (up and down when vertical) and turn around in right-to-left text, where the slides scroll the other way too.",
  },
  chart: {
    status: "supported",
    summary:
      "Charts on recharts, coloured with the theme's chart tokens, with a tooltip and a legend.",
    exports: [
      "Area",
      "AreaChart",
      "Bar",
      "BarChart",
      "Brush",
      "CartesianGrid",
      "ChartContainer",
      "ChartLegend",
      "ChartLegendContent",
      "ChartTooltip",
      "ChartTooltipContent",
      "ComposedChart",
      "Funnel",
      "FunnelChart",
      "Label",
      "LabelList",
      "Line",
      "LineChart",
      "Pie",
      "PieChart",
      "PolarAngleAxis",
      "PolarGrid",
      "PolarRadiusAxis",
      "Radar",
      "RadarChart",
      "RadialBar",
      "RadialBarChart",
      "ReferenceArea",
      "ReferenceDot",
      "ReferenceLine",
      "Scatter",
      "ScatterChart",
      "Treemap",
      "XAxis",
      "YAxis",
      "ZAxis",
      "chartColor",
      "chartColors",
    ],
    changes:
      "A series' colour is a chart token (`chart-1` to `chart-5`): marks take `chartColor(token)`, markers use the token's class. No `<style>` element, no inline styles, no ChartStyle, and no per-theme colours: the tokens have their own dark values. Hands on recharts' charts and their parts, since screens can't import recharts. The chart's surface shows a focus ring instead of hiding it. The tooltip shows numeric labels, such as a year, and the tooltip and legend content hand HTML props (id, ARIA, data) on to their element.",
  },
  checkbox: {
    status: "supported",
    summary: "A box to tick, on or off.",
    exports: ["Checkbox"],
  },
  collapsible: {
    status: "supported",
    summary: "One section that shows or hides.",
    exports: ["Collapsible", "CollapsibleContent", "CollapsibleTrigger"],
  },
  combobox: {
    status: "supported",
    summary: "An input that filters a list of options to pick one or more.",
    exports: [
      "Combobox",
      "ComboboxChip",
      "ComboboxChips",
      "ComboboxChipsInput",
      "ComboboxCollection",
      "ComboboxContent",
      "ComboboxEmpty",
      "ComboboxGroup",
      "ComboboxInput",
      "ComboboxItem",
      "ComboboxLabel",
      "ComboboxList",
      "ComboboxSeparator",
      "ComboboxTrigger",
      "ComboboxValue",
      "useComboboxAnchor",
    ],
    changes:
      "`triggerLabel` and `clearLabel` name the input's trigger and clear buttons, which upstream leaves without a name.",
  },
  command: {
    status: "supported",
    summary: "A searchable list of commands, on its own or in a dialog.",
    exports: [
      "Command",
      "CommandDialog",
      "CommandEmpty",
      "CommandGroup",
      "CommandInput",
      "CommandItem",
      "CommandList",
      "CommandSeparator",
      "CommandShortcut",
    ],
  },
  "context-menu": {
    status: "supported",
    summary: "A menu that opens on right click or long press.",
    exports: [
      "ContextMenu",
      "ContextMenuCheckboxItem",
      "ContextMenuContent",
      "ContextMenuGroup",
      "ContextMenuItem",
      "ContextMenuLabel",
      "ContextMenuPortal",
      "ContextMenuRadioGroup",
      "ContextMenuRadioItem",
      "ContextMenuSeparator",
      "ContextMenuShortcut",
      "ContextMenuSub",
      "ContextMenuSubContent",
      "ContextMenuSubTrigger",
      "ContextMenuTrigger",
    ],
  },
  dialog: {
    status: "supported",
    summary: "A modal window over the page.",
    exports: [
      "Dialog",
      "DialogClose",
      "DialogContent",
      "DialogDescription",
      "DialogFooter",
      "DialogHeader",
      "DialogOverlay",
      "DialogPortal",
      "DialogTitle",
      "DialogTrigger",
    ],
    changes:
      "`closeLabel` names the close button, for translations. The overlay dims the page with the theme's `scrim` token instead of raw black.",
  },
  direction: {
    status: "supported",
    summary: "Sets left-to-right or right-to-left for the components inside.",
    exports: ["DirectionProvider", "useDirection"],
  },
  drawer: {
    status: "supported",
    summary: "A panel that slides in from an edge and can be swiped away.",
    exports: [
      "Drawer",
      "DrawerClose",
      "DrawerContent",
      "DrawerDescription",
      "DrawerFooter",
      "DrawerHeader",
      "DrawerOverlay",
      "DrawerPortal",
      "DrawerSwipeHandle",
      "DrawerTitle",
      "DrawerTrigger",
    ],
    changes:
      "The overlay dims the page with the theme's `scrim` token instead of raw black.",
  },
  "dropdown-menu": {
    status: "supported",
    summary: "A menu of actions that opens from a button.",
    exports: [
      "DropdownMenu",
      "DropdownMenuCheckboxItem",
      "DropdownMenuContent",
      "DropdownMenuGroup",
      "DropdownMenuItem",
      "DropdownMenuLabel",
      "DropdownMenuPortal",
      "DropdownMenuRadioGroup",
      "DropdownMenuRadioItem",
      "DropdownMenuSeparator",
      "DropdownMenuShortcut",
      "DropdownMenuSub",
      "DropdownMenuSubContent",
      "DropdownMenuSubTrigger",
      "DropdownMenuTrigger",
    ],
  },
  empty: {
    status: "supported",
    summary: "What a list or page shows when it has nothing yet.",
    exports: [
      "Empty",
      "EmptyContent",
      "EmptyDescription",
      "EmptyHeader",
      "EmptyMedia",
      "EmptyTitle",
    ],
  },
  field: {
    status: "supported",
    summary:
      "A form field: its label, control, description and error. Forms are built from fields.",
    exports: [
      "Field",
      "FieldContent",
      "FieldDescription",
      "FieldError",
      "FieldGroup",
      "FieldLabel",
      "FieldLegend",
      "FieldSeparator",
      "FieldSet",
      "FieldTitle",
    ],
  },
  form: {
    status: "unsupported",
    reason:
      "The registry entry has no files: shadcn replaced its form component with Field.",
    instead: "field",
  },
  "hover-card": {
    status: "supported",
    summary: "A preview card that opens when a link is hovered or focused.",
    exports: ["HoverCard", "HoverCardContent", "HoverCardTrigger"],
  },
  input: {
    status: "supported",
    summary: "A one-line text input.",
    exports: ["Input"],
  },
  "input-group": {
    status: "supported",
    summary: "An input with buttons, icons or text attached.",
    exports: [
      "InputGroup",
      "InputGroupAddon",
      "InputGroupButton",
      "InputGroupInput",
      "InputGroupText",
      "InputGroupTextarea",
    ],
  },
  "input-otp": {
    status: "supported",
    summary: "A one-time code input, one box per character.",
    exports: ["InputOTP", "InputOTPGroup", "InputOTPSeparator", "InputOTPSlot"],
    changes:
      "Its slots take only the width they need, so the input's room for a password manager's badge doesn't push the page sideways on a phone. The kit's stylesheet carries the rules input-otp adds at runtime in a `<style>` element, which a strict style-src blocks.",
  },
  item: {
    status: "supported",
    summary: "A row with media, a title, a description and actions.",
    exports: [
      "Item",
      "ItemActions",
      "ItemContent",
      "ItemDescription",
      "ItemFooter",
      "ItemGroup",
      "ItemHeader",
      "ItemMedia",
      "ItemSeparator",
      "ItemTitle",
    ],
  },
  kbd: {
    status: "supported",
    summary: "A keyboard key, as in a shortcut.",
    exports: ["Kbd", "KbdGroup"],
  },
  label: {
    status: "supported",
    summary: "A label for a control.",
    exports: ["Label"],
  },
  marker: {
    status: "supported",
    summary: "A line of context in a conversation, such as a date or an event.",
    exports: ["Marker", "MarkerContent", "MarkerIcon", "markerVariants"],
  },
  menubar: {
    status: "supported",
    summary: "A row of menus, as in a desktop app.",
    exports: [
      "Menubar",
      "MenubarCheckboxItem",
      "MenubarContent",
      "MenubarGroup",
      "MenubarItem",
      "MenubarLabel",
      "MenubarMenu",
      "MenubarPortal",
      "MenubarRadioGroup",
      "MenubarRadioItem",
      "MenubarSeparator",
      "MenubarShortcut",
      "MenubarSub",
      "MenubarSubContent",
      "MenubarSubTrigger",
      "MenubarTrigger",
    ],
    changes:
      "Its triggers show a focus ring from the keyboard; upstream hides the outline and shows nothing.",
  },
  message: {
    status: "supported",
    summary: "A chat message: who sent it, its content and its footer.",
    exports: [
      "Message",
      "MessageAvatar",
      "MessageContent",
      "MessageFooter",
      "MessageGroup",
      "MessageHeader",
    ],
  },
  "message-scroller": {
    status: "supported",
    summary:
      "A conversation's scrolling area that keeps to the newest message.",
    exports: [
      "MessageScroller",
      "MessageScrollerButton",
      "MessageScrollerContent",
      "MessageScrollerItem",
      "MessageScrollerProvider",
      "MessageScrollerViewport",
      "useMessageScroller",
      "useMessageScrollerScrollable",
      "useMessageScrollerVisibility",
    ],
  },
  "native-select": {
    status: "supported",
    summary: "The browser's own select, styled.",
    exports: ["NativeSelect", "NativeSelectOptGroup", "NativeSelectOption"],
  },
  "navigation-menu": {
    status: "supported",
    summary: "Site navigation with links and panels that open from them.",
    exports: [
      "NavigationMenu",
      "NavigationMenuContent",
      "NavigationMenuIndicator",
      "NavigationMenuItem",
      "NavigationMenuLink",
      "NavigationMenuList",
      "NavigationMenuPositioner",
      "NavigationMenuTrigger",
      "navigationMenuTriggerStyle",
    ],
    changes:
      "Fixes upstream's slide classes for the activation direction, which Tailwind didn't know, and drops two that did nothing.",
  },
  pagination: {
    status: "supported",
    summary: "Links to the pages of a long list.",
    exports: [
      "Pagination",
      "PaginationContent",
      "PaginationEllipsis",
      "PaginationItem",
      "PaginationLink",
      "PaginationNext",
      "PaginationPrevious",
    ],
  },
  popover: {
    status: "supported",
    summary: "Content in a floating panel, anchored to a button.",
    exports: [
      "Popover",
      "PopoverContent",
      "PopoverDescription",
      "PopoverHeader",
      "PopoverTitle",
      "PopoverTrigger",
    ],
  },
  progress: {
    status: "supported",
    summary: "How far a task has got.",
    exports: [
      "Progress",
      "ProgressIndicator",
      "ProgressLabel",
      "ProgressTrack",
      "ProgressValue",
    ],
  },
  questionnaire: {
    status: "supported",
    summary:
      "Questions asked one at a time, with choices, progress and a submit.",
    exports: [
      "Questionnaire",
      "QuestionnaireActions",
      "QuestionnaireChoice",
      "QuestionnaireChoiceDescription",
      "QuestionnaireChoices",
      "QuestionnaireDescription",
      "QuestionnaireError",
      "QuestionnaireInput",
      "QuestionnaireItem",
      "QuestionnaireNext",
      "QuestionnairePrevious",
      "QuestionnaireProgress",
      "QuestionnaireSkip",
      "QuestionnaireSubmit",
      "QuestionnaireTitle",
    ],
  },
  "radio-group": {
    status: "supported",
    summary: "A set of options, one of which is picked.",
    exports: ["RadioGroup", "RadioGroupItem"],
  },
  resizable: {
    status: "supported",
    summary: "Panels with handles to drag their sizes.",
    exports: ["ResizableHandle", "ResizablePanel", "ResizablePanelGroup"],
  },
  "scroll-area": {
    status: "supported",
    summary: "A region that scrolls, with a thin scrollbar.",
    exports: ["ScrollArea", "ScrollBar"],
  },
  select: {
    status: "supported",
    summary: "A button that opens a list to pick one option.",
    exports: [
      "Select",
      "SelectContent",
      "SelectGroup",
      "SelectItem",
      "SelectLabel",
      "SelectScrollDownButton",
      "SelectScrollUpButton",
      "SelectSeparator",
      "SelectTrigger",
      "SelectValue",
    ],
  },
  separator: {
    status: "supported",
    summary: "A line between content.",
    exports: ["Separator"],
  },
  sheet: {
    status: "supported",
    summary: "A dialog that slides in from an edge of the screen.",
    exports: [
      "Sheet",
      "SheetClose",
      "SheetContent",
      "SheetDescription",
      "SheetFooter",
      "SheetHeader",
      "SheetTitle",
      "SheetTrigger",
    ],
    changes:
      "`closeLabel` names the close button, for translations. The overlay dims the page with the theme's `scrim` token instead of raw black.",
  },
  sidebar: {
    status: "supported",
    summary:
      "A collapsible side navigation, a sheet on a phone. For a page's own navigation.",
    exports: [
      "Sidebar",
      "SidebarContent",
      "SidebarFooter",
      "SidebarGroup",
      "SidebarGroupAction",
      "SidebarGroupContent",
      "SidebarGroupLabel",
      "SidebarHeader",
      "SidebarInput",
      "SidebarInset",
      "SidebarMenu",
      "SidebarMenuAction",
      "SidebarMenuBadge",
      "SidebarMenuButton",
      "SidebarMenuItem",
      "SidebarMenuSkeleton",
      "SidebarMenuSub",
      "SidebarMenuSubButton",
      "SidebarMenuSubItem",
      "SidebarProvider",
      "SidebarRail",
      "SidebarSeparator",
      "SidebarTrigger",
      "useSidebar",
    ],
    changes:
      "The inset's dark shadow uses the theme's `scrim` token instead of raw black.",
  },
  skeleton: {
    status: "supported",
    summary: "A placeholder shape while content loads.",
    exports: ["Skeleton"],
  },
  slider: {
    status: "supported",
    summary: "A handle dragged along a track to pick a value or a range.",
    exports: ["Slider"],
    changes:
      "The thumb is filled with the theme's `background` instead of raw white, so it follows dark mode. A single number as the value gets one thumb; upstream gave it two.",
  },
  sonner: {
    status: "unsupported",
    reason:
      "A second toast system on the sonner package, themed through next-themes, a Next.js library; the kit's Toast is the Base UI one.",
    instead: "toast",
  },
  spinner: {
    status: "supported",
    summary: "Shows that something is loading.",
    exports: ["Spinner"],
  },
  switch: {
    status: "supported",
    summary: "A toggle for a setting, on or off.",
    exports: ["Switch"],
  },
  table: {
    status: "supported",
    summary: "A table of rows and columns.",
    exports: [
      "Table",
      "TableBody",
      "TableCaption",
      "TableCell",
      "TableFooter",
      "TableHead",
      "TableHeader",
      "TableRow",
    ],
  },
  tabs: {
    status: "supported",
    summary: "Views of one area, one at a time, picked by tab.",
    exports: [
      "Tabs",
      "TabsContent",
      "TabsList",
      "TabsTrigger",
      "tabsListVariants",
    ],
  },
  textarea: {
    status: "supported",
    summary: "A text input over several lines.",
    exports: ["Textarea"],
  },
  toast: {
    status: "supported",
    summary: "A short message that appears and goes away by itself.",
    exports: [
      "Toast",
      "ToastAction",
      "ToastClose",
      "ToastContent",
      "ToastDescription",
      "ToastPortal",
      "ToastProvider",
      "ToastTitle",
      "ToastViewport",
      "Toaster",
      "createToastManager",
      "toast",
      "useToastManager",
    ],
  },
  toggle: {
    status: "supported",
    summary: "A button that stays pressed or not.",
    exports: ["Toggle", "toggleVariants"],
  },
  "toggle-group": {
    status: "supported",
    summary: "Toggles of which one, or several, are pressed.",
    exports: ["ToggleGroup", "ToggleGroupItem"],
    changes:
      "`spacing` is 0 to 4, each a static gap class, instead of any number in an inline style. `orientation` reaches Base UI too, so a vertical group moves with the up and down arrows.",
  },
  tooltip: {
    status: "supported",
    summary: "A short label that shows on hover or focus.",
    exports: ["Tooltip", "TooltipContent", "TooltipProvider", "TooltipTrigger"],
  },
} as const satisfies Record<string, CatalogEntry>;

export type ShadcnComponent = keyof typeof shadcnComponents;

/**
 * The kit's own components, not in shadcn: layout primitives for composing
 * a screen. Optional, and without page chrome of their own.
 */
export const graspComponents = {
  grid: {
    status: "supported",
    summary:
      "Equal columns that wrap: one on a phone, up to `columns` on a wide screen.",
    exports: ["Grid", "gridVariants"],
  },
  inline: {
    status: "supported",
    summary: "Children in a row that wraps, such as actions or tags.",
    exports: ["Inline", "inlineVariants"],
  },
  "page-header": {
    status: "supported",
    summary: "A page's title, description and actions.",
    exports: [
      "PageHeader",
      "PageHeaderActions",
      "PageHeaderContent",
      "PageHeaderDescription",
      "PageHeaderTitle",
    ],
  },
  "split-pane": {
    status: "supported",
    summary:
      "A main pane and a side pane, stacked on a phone and side by side from `md` up.",
    exports: [
      "SplitPane",
      "SplitPaneAside",
      "SplitPaneMain",
      "splitPaneAsideVariants",
    ],
  },
  stack: {
    status: "supported",
    summary: "Children in a column with an even gap.",
    exports: ["Stack", "stackVariants"],
  },
} as const satisfies Record<string, SupportedEntry>;

export type GraspComponent = keyof typeof graspComponents;

/** Every component in the kit: shadcn's it has, and its own. */
export type KitComponent =
  | {
      [Name in ShadcnComponent]: (typeof shadcnComponents)[Name] extends {
        status: "supported";
      }
        ? Name
        : never;
    }[ShadcnComponent]
  | GraspComponent;

/** The specifier screens import a component's module by. */
export const componentImport = (name: KitComponent): string =>
  `@grasp-os/ui/components/${name}`;

/** An example of composing the kit into a screen. */
export interface ExampleEntry {
  /** What it shows, in a line. */
  summary: string;
  /** The components it imports. */
  uses: readonly KitComponent[];
}

/**
 * Short examples for agents that build screens: how the kit's components
 * compose into common screens. Each is in `catalog/examples/<name>.tsx`,
 * and `catalog/examples.ts` loads one by name, only when asked for.
 */
export const examples = {
  list: {
    summary:
      "A list of records with a page header, a status per record and an empty state.",
    uses: ["badge", "button", "empty", "item", "page-header", "stack"],
  },
  "detail-form": {
    summary:
      "A record's detail form: labelled fields in groups, a description, an error and the actions.",
    uses: [
      "button",
      "field",
      "inline",
      "input",
      "page-header",
      "select",
      "stack",
      "switch",
      "textarea",
    ],
  },
  dialog: {
    summary:
      "A dialog that asks for input, and an alert dialog that confirms a destructive action.",
    uses: ["alert-dialog", "button", "dialog", "field", "inline", "input"],
  },
  table: {
    summary:
      "A table with a labelled search, a caption, numbers aligned right and pages.",
    uses: ["badge", "input-group", "pagination", "stack", "table"],
  },
  "responsive-navigation": {
    summary:
      "Links in a row on a wide screen and in a sheet behind a menu button on a phone.",
    uses: ["button", "inline", "sheet", "stack"],
  },
  "specialised-panel": {
    summary:
      "The main work beside an inspector for the selected record, with tabs for its details and history.",
    uses: [
      "badge",
      "card",
      "progress",
      "scroll-area",
      "separator",
      "split-pane",
      "tabs",
    ],
  },
} as const satisfies Record<string, ExampleEntry>;

export type ExampleName = keyof typeof examples;
