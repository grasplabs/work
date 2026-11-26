// The icons of Damsko: the one way an icon is drawn, and the house set. Every drawing is a
// Hugeicons drawing (only from there), drawn by Icon, at its holder's size and stroke.
//
// The house set holds the drawings Damsko's own parts draw, and the shapes products share a meaning
// for, each named by its shape with an `Icon` suffix, as lucide names them (`CheckIcon`, `XIcon`,
// `EllipsisIcon`), so a part asks for a shape, not for `Tick02Icon`, and every product draws "more
// actions" with the same drawing. A Damsko part imports only from here. Any other drawing a product
// needs it imports from @hugeicons/core-free-icons itself, the package this file draws from, and
// draws through the same Icon, with no change here: a named import of one drawing, which a
// bundler keeps alone (the package has no side effects), as it keeps only the house set's
// drawings a page uses. A drawing that points along the line is marked with `directional` where it
// is named. One that every product comes to share moves into the house set.
//
//   <Icon icon={PlusIcon} />                  beside words: hidden from screen readers
//   <Icon icon={PlusIcon} label={add} />      standing alone, with a name
//   <Icon icon={FloppyDiskIcon} />            any Hugeicons drawing, imported by the product
//
// Icon draws with the stroke and size the holder sets through iconVars (vars.stylex.ts): a button
// sets them for the icons in it, and an icon on its own takes the defaults (16px, a 1.5 stroke).
// Written with createElement, so the file stays .ts. Brand logos are not here: the product keeps
// them, made with filledMark.
import {
  Add01Icon,
  AiBrain01Icon,
  AiMagicIcon,
  AiUserIcon,
  Alert02Icon,
  AlertCircleIcon,
  Analytics01Icon,
  AppWindowIcon as HugeAppWindowIcon,
  Archive02Icon,
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowExpand01Icon,
  ArrowLeft01Icon,
  ArrowLeft02Icon,
  ArrowLeftRightIcon as HugeArrowLeftRightIcon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowShrink01Icon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  ArrowUpDownIcon as HugeArrowUpDownIcon,
  ArrowUpRight01Icon,
  Attachment01Icon,
  AudioWave01Icon,
  BubbleChatIcon,
  Building03Icon,
  CableIcon as HugeCableIcon,
  Calendar03Icon,
  Cancel01Icon,
  ChartDecreaseIcon,
  ChartIncreaseIcon,
  ChartLineData01Icon,
  CheckListIcon,
  CheckmarkCircle02Icon,
  CheckmarkSquare02Icon,
  CircleIcon as HugeCircleIcon,
  Clock01Icon,
  Coins01Icon,
  ComputerIcon,
  ComputerTerminal01Icon,
  ContrastIcon as HugeContrastIcon,
  Copy01Icon,
  Cursor02Icon,
  DashboardSquare01Icon,
  Database01Icon,
  Delete02Icon,
  Doc01Icon,
  Dollar01Icon,
  Download01Icon,
  EditOff03Icon,
  File01Icon,
  FileCodeIcon as HugeFileCodeIcon,
  FileEditIcon,
  FitToScreenIcon,
  FloorPlanIcon as HugeFloorPlanIcon,
  Folder01Icon,
  FolderKanbanIcon as HugeFolderKanbanIcon,
  GitCompareIcon as HugeGitCompareIcon,
  Globe02Icon,
  GlobeIcon as HugeGlobeIcon,
  GoBackward10SecIcon,
  GoForward10SecIcon,
  GridViewIcon,
  GripVerticalIcon as HugeGripVerticalIcon,
  HashtagIcon,
  HelpCircleIcon,
  Home01Icon,
  Idea01Icon,
  Image01Icon,
  InboxIcon as HugeInboxIcon,
  InformationCircleIcon,
  InputTextIcon,
  Invoice01Icon,
  Key01Icon,
  LabsIcon,
  LaptopIcon as HugeLaptopIcon,
  LeftToRightListBulletIcon,
  LeftToRightListDashIcon,
  Link04Icon,
  Loading03Icon,
  Location01Icon,
  Logout03Icon,
  Mail01Icon,
  Message01Icon,
  Mic01Icon,
  MinusSignCircleIcon,
  MinusSignIcon,
  Moon02Icon,
  MoreHorizontalIcon,
  Note01Icon,
  Notification03Icon,
  PauseIcon as HugePauseIcon,
  Pdf01Icon,
  PencilEdit02Icon,
  PlayIcon as HugePlayIcon,
  Redo02Icon,
  Refresh01Icon,
  RepeatIcon as HugeRepeatIcon,
  Rocket01Icon,
  ScaleIcon as HugeScaleIcon,
  Search01Icon,
  SearchAddIcon,
  SearchMinusIcon,
  Sent02Icon,
  ServerStack01Icon,
  Settings01Icon,
  Share08Icon,
  SheetIcon as HugeSheetIcon,
  ShieldAlertIcon as HugeShieldAlertIcon,
  SidebarLeftIcon,
  SidebarRightIcon,
  SlidersHorizontalIcon as HugeSlidersHorizontalIcon,
  SmartPhone01Icon,
  SourceCodeIcon,
  SparklesIcon as HugeSparklesIcon,
  SplitIcon as HugeSplitIcon,
  SquareLock02Icon,
  StarIcon as HugeStarIcon,
  StopIcon,
  Sun03Icon,
  TableIcon as HugeTableIcon,
  Tablet01Icon,
  Tag01Icon,
  Task01Icon,
  TextAlignCenterIcon as HugeTextAlignCenterIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
  TextBoldIcon,
  TextFontIcon,
  TextIcon as HugeTextIcon,
  TextItalicIcon,
  TextUnderlineIcon,
  ThumbsDownIcon as HugeThumbsDownIcon,
  ThumbsUpIcon as HugeThumbsUpIcon,
  Tick02Icon,
  Undo02Icon,
  UnfoldMoreIcon,
  Upload01Icon,
  UserAdd01Icon,
  UserCircleIcon,
  UserGroupIcon,
  Video01Icon,
  ViewIcon,
  ViewOffSlashIcon,
  VolumeHighIcon,
  VolumeMute01Icon,
  WorkflowSquare03Icon,
  Wrench01Icon,
  ZapIcon as HugeZapIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import * as stylex from "@stylexjs/stylex";
import { createElement, useId } from "react";

import type { LayoutStyle } from "./utils";
import { iconVars } from "./vars.stylex";

/** An icon's drawing: one of the exports below, or a mark made with filledMark. */
export type IconData = IconSvgElement;

// The drawings that point along the line (an arrow, a chevron, send, undo): in right-to-left text
// they turn round, so "next" still points the way the line runs. Every other icon stays as drawn.
const pointers = new WeakSet<object>();

// Filled marks (a brand's logo, made by the product): filled shapes in their own colours, never
// stroked, with an optional linear gradient.
const filled = new WeakSet<object>();

// The filled forms (ThumbsUpFilledIcon): the outline's own geometry with its closed shapes filled
// in the ink as well as stroked, for an action that stays on.
const solids = new WeakSet<object>();

/** Marks a drawing as a filled mark (a brand's logo), drawn without the token's stroke. */
export const filledMark = (icon: IconData): IconData => {
  filled.add(icon);
  return icon;
};

/** The filled form of a drawing: a copy of it, drawn with its closed shapes filled in the ink. */
const solidForm = (icon: IconData): IconData => {
  const copy: IconData = [...icon];
  solids.add(copy);
  return copy;
};

/**
 * Marks a drawing as directional: one that points along the line (an arrow, a chevron, send,
 * undo), so it mirrors in right-to-left text. The house set's are marked already; mark a Hugeicons
 * drawing a product imports itself once, where it is named (`const NextIcon =
 * directional(ArrowRight03Icon)`).
 */
export const directional = (icon: IconData): IconData => {
  pointers.add(icon);
  return icon;
};

const styles = stylex.create({
  icon: {
    display: "block",
    flexShrink: 0,
    width: iconVars.size,
    height: iconVars.size,
    // Inherited by every path, so the stroke is set once, here.
    stroke: "currentColor",
    strokeWidth: iconVars.stroke,
    // The drawing never catches a click meant for the control it is in.
    pointerEvents: "none",
  },
  filled: { stroke: "none" },
  solid: { fill: "currentColor" },
  // Turned with `scale`. Once a UI SDK item icon has been drawn, UI SDK's own rule turns every
  // hidden [data-mirror] drawing on the page with `scale` in right to left, so any pointing icon
  // (leading an item, at its end, or on its own) gets the one value from both and turns once.
  mirror: {
    scale: { default: null, ":dir(rtl)": "-1 1" },
  },
});

export interface IconProps {
  icon: IconData;
  /**
   * What the icon means, when nothing else says it. Leave it out when the icon sits beside words
   * that say the same (the usual case): it is then hidden from screen readers.
   */
  label?: string;
  /** Where it sits: layout only. */
  style?: LayoutStyle;
}

/** The attributes Hugeicons writes on each part that the token's stroke (set on the svg) replaces. */
const replaced = new Set(["key", "stroke", "strokeWidth"]);

/** A part's attributes, the token's stroke left to the svg and a gradient fill pointed at this icon's own. */
const partProps = (
  attrs: IconData[number][1],
  index: number,
  gradient: string
) =>
  Object.fromEntries(
    Object.entries({ ...attrs, key: String(attrs.key ?? index) })
      .filter(([name]) => !replaced.has(name) || name === "key")
      .map(([name, value]) => [
        name,
        value === "url(#gradient)" ? `url(#${gradient})` : value,
      ])
  );

/** A filled mark's gradient: its stops written "offset colour;offset colour". */
const gradientOf = (attrs: IconData[number][1], id: string) => {
  const line = Object.fromEntries(
    Object.entries(attrs).filter(([name]) => name !== "key" && name !== "stops")
  );
  return createElement(
    "defs",
    { key: "defs" },
    createElement(
      "linearGradient",
      { ...line, id, gradientUnits: "userSpaceOnUse" },
      String(attrs.stops)
        .split(";")
        .map((stop) => {
          const [offset = "0", color = "currentColor"] = stop.split(" ");
          return createElement("stop", {
            key: offset,
            offset,
            stopColor: color,
          });
        })
    )
  );
};

/** An icon, at the size and stroke its holder sets. */
export const Icon = ({ icon, label, style }: IconProps) => {
  const named = label !== undefined && label !== "";
  // One gradient per icon on the page, so a mark in a closed popover never takes another's.
  const gradient = `icon${useId().replaceAll(/[^\w-]/gu, "")}`;
  return createElement(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: "0 0 24 24",
      fill: "none",
      focusable: "false",
      role: named ? "img" : undefined,
      "aria-label": label,
      "aria-hidden": named ? undefined : true,
      // Said on the drawing, so a check can tell a mirrored icon from one drawn as it is.
      "data-mirror": pointers.has(icon) ? "" : undefined,
      ...stylex.props(
        styles.icon,
        filled.has(icon) && styles.filled,
        solids.has(icon) && styles.solid,
        pointers.has(icon) && styles.mirror,
        style
      ),
    },
    icon.map(([tag, attrs], index) =>
      tag === "linearGradient"
        ? gradientOf(attrs, gradient)
        : createElement(tag, partProps(attrs, index, gradient))
    )
  );
};

// ---- The house set, by shape -----------------------------------------------------------------------

/** One app, as a window. AppWindowIcon. */
export const AppWindowIcon: IconData = HugeAppWindowIcon;
/** Put away, out of the list: Archive. Archive02Icon. */
export const ArchiveIcon: IconData = Archive02Icon;
/** A column sorted from high to low. ArrowDown02Icon. */
export const ArrowDownIcon: IconData = ArrowDown02Icon;
/** Go back a step. ArrowLeft02Icon. */
export const ArrowLeftIcon: IconData =
  /* @__PURE__ */
  directional(ArrowLeft02Icon);
/** Switch to another: an account, an organisation. ArrowLeftRightIcon. */
export const ArrowLeftRightIcon: IconData = HugeArrowLeftRightIcon;
/** Go on to the next step. ArrowRight02Icon: an arrow with a stem, never a chevron. */
export const ArrowRightIcon: IconData =
  /* @__PURE__ */
  directional(ArrowRight02Icon);
/** A column that can be sorted, and is not. ArrowUpDownIcon. */
export const ArrowUpDownIcon: IconData = HugeArrowUpDownIcon;
/** A column sorted from low to high. ArrowUp02Icon. */
export const ArrowUpIcon: IconData = ArrowUp02Icon;
/** A link that opens another site, in a new tab. ArrowUpRight01Icon. */
export const ArrowUpRightIcon: IconData =
  /* @__PURE__ */
  directional(ArrowUpRight01Icon);
/** Listening: dictation is on and hearing you. AudioWave01Icon. */
export const AudioWaveformIcon: IconData = AudioWave01Icon;
/** Notifications. Notification03Icon. */
export const BellIcon: IconData = Notification03Icon;
/** Bold text. TextBoldIcon. */
export const BoldIcon: IconData = TextBoldIcon;
/** A brain: knowledge, memory. AiBrain01Icon. */
export const BrainIcon: IconData = AiBrain01Icon;
/** A company or an organisation. Building03Icon. */
export const BuildingIcon: IconData = Building03Icon;
/** A connection, as a cable: integrations. CableIcon. */
export const CableIcon: IconData = HugeCableIcon;
/** Opens a calendar to choose a date. Calendar03Icon. */
export const CalendarIcon: IconData = Calendar03Icon;
/** Reports and figures. Analytics01Icon. */
export const ChartColumnIcon: IconData = Analytics01Icon;
/** A number that is measured: views, a score. ChartLineData01Icon. */
export const ChartLineIcon: IconData = ChartLineData01Icon;
/** Done. Tick02Icon. */
export const CheckIcon: IconData = Tick02Icon;
/** Opens a list below its control: a select, a menu. ArrowDown01Icon: a chevron, never an arrow. */
export const ChevronDownIcon: IconData = ArrowDown01Icon;
/** A step back: Previous, in a pagination. ArrowLeft01Icon. */
export const ChevronLeftIcon: IconData =
  /* @__PURE__ */
  directional(ArrowLeft01Icon);
/** A step on: Next, in a pagination. ArrowRight01Icon. */
export const ChevronRightIcon: IconData =
  /* @__PURE__ */
  directional(ArrowRight01Icon);
/** A step up: the section before, in a viewer. ArrowUp01Icon. */
export const ChevronUpIcon: IconData = ArrowUp01Icon;
/** A menu that opens up and down from where it stands (a profile's). UnfoldMoreIcon. */
export const ChevronsUpDownIcon: IconData = UnfoldMoreIcon;
/** It went wrong: an error that stops something. AlertCircleIcon. */
export const CircleAlertIcon: IconData = AlertCircleIcon;
/** It went well: done, ready. CheckmarkCircle02Icon. */
export const CircleCheckIcon: IconData = CheckmarkCircle02Icon;
/** A question, or help: what the person is asked, or where to get help. HelpCircleIcon. */
export const CircleHelpIcon: IconData = HelpCircleIcon;
/** A step still to come. CircleIcon. */
export const CircleIcon: IconData = HugeCircleIcon;
/** A step left out. MinusSignCircleIcon. */
export const CircleMinusIcon: IconData = MinusSignCircleIcon;
/** A person: an owner, an assignee. UserCircleIcon. */
export const CircleUserIcon: IconData = UserCircleIcon;
/** Tasks, a to-do list. Task01Icon. */
export const ClipboardListIcon: IconData = Task01Icon;
/** Time ran out: an expired request. Clock01Icon. */
export const ClockIcon: IconData = Clock01Icon;
/** Code: a file of source, some of its lines. SourceCodeIcon. */
export const CodeIcon: IconData = SourceCodeIcon;
/** Money: revenue, spend, a price. Coins01Icon. */
export const CoinsIcon: IconData = Coins01Icon;
/** Light and dark: the theme. ContrastIcon. */
export const ContrastIcon: IconData = HugeContrastIcon;
/** Copy to the clipboard. Copy01Icon. */
export const CopyIcon: IconData = Copy01Icon;
/** A source of records: a table, a database. Database01Icon. */
export const DatabaseIcon: IconData = Database01Icon;
/** A column of money. Dollar01Icon. */
export const DollarSignIcon: IconData = Dollar01Icon;
/** Download a file. Download01Icon. */
export const DownloadIcon: IconData = Download01Icon;
/** More actions, in a menu. MoreHorizontalIcon. */
export const EllipsisIcon: IconData = MoreHorizontalIcon;
/** Show what is hidden, like a password. ViewIcon. */
export const EyeIcon: IconData = ViewIcon;
/** Hide it again. ViewOffSlashIcon. */
export const EyeOffIcon: IconData = ViewOffSlashIcon;
/** A document. Doc01Icon. */
export const FileDocIcon: IconData = Doc01Icon;
/** A file of code: a source file, a test file. FileCodeIcon. */
export const FileCodeIcon: IconData = HugeFileCodeIcon;
/** A file. File01Icon. */
export const FileIcon: IconData = File01Icon;
/** A record: a deal, a ticket, an invoice. Invoice01Icon. */
export const FileInvoiceIcon: IconData = Invoice01Icon;
/** A PDF file. Pdf01Icon. */
export const FilePdfIcon: IconData = Pdf01Icon;
/** A file changed. FileEditIcon. */
export const FilePenIcon: IconData = FileEditIcon;
/** A test run: an experiment's flask. LabsIcon. */
export const FlaskConicalIcon: IconData = LabsIcon;
/** A plan of the rooms: a layout, a workspace's map. FloorPlanIcon. */
export const FloorPlanIcon: IconData = HugeFloorPlanIcon;
/** A folder or a project that holds files. Folder01Icon. */
export const FolderIcon: IconData = Folder01Icon;
/** Projects, as a board in a folder. FolderKanbanIcon. */
export const FolderKanbanIcon: IconData = HugeFolderKanbanIcon;
/** Compare two versions side by side. GitCompareIcon. */
export const GitCompareIcon: IconData = HugeGitCompareIcon;
/** The web: a page or a site. Globe02Icon. */
export const Globe2Icon: IconData = Globe02Icon;
/** Every language, or the world: the language switch's button. GlobeIcon. */
export const GlobeIcon: IconData = HugeGlobeIcon;
/** Go back 10 seconds. GoBackward10SecIcon. */
export const GoBackward10Icon: IconData = GoBackward10SecIcon;
/** Go forward 10 seconds. GoForward10SecIcon. */
export const GoForward10Icon: IconData = GoForward10SecIcon;
/** A handle to drag: an item of a list put in order by hand. GripVerticalIcon. */
export const GripVerticalIcon: IconData = HugeGripVerticalIcon;
/** A column of numbers. HashtagIcon. */
export const HashIcon: IconData = HashtagIcon;
/** The first page, a workspace's home. Home01Icon. */
export const HouseIcon: IconData = Home01Icon;
/** An image or a picture. Image01Icon. */
export const ImageIcon: IconData = Image01Icon;
/** Nothing here yet: an empty list or inbox. InboxIcon. */
export const InboxIcon: IconData = HugeInboxIcon;
/** Something to know: a note, an explanation. InformationCircleIcon. */
export const InfoIcon: IconData = InformationCircleIcon;
/** Italic text. TextItalicIcon. */
export const ItalicIcon: IconData = TextItalicIcon;
/** A key: an AI provider's key, an API key, a secret. Key01Icon. */
export const KeyIcon: IconData = Key01Icon;
/** A desktop's width: shown as on a laptop or a desktop. LaptopIcon. */
export const LaptopIcon: IconData = HugeLaptopIcon;
/** Apps, as panels on a page. DashboardSquare01Icon. */
export const LayoutDashboardIcon: IconData = DashboardSquare01Icon;
/** Show as a grid. GridViewIcon. */
export const LayoutGridIcon: IconData = GridViewIcon;
/** A thought: the agent reasoning. Idea01Icon. */
export const LightbulbIcon: IconData = Idea01Icon;
/** A link to a place, or copy its address. Link04Icon. */
export const LinkIcon: IconData = Link04Icon;
/** A list of steps to do: a tour, a checklist. CheckListIcon. */
export const ListChecksIcon: IconData = CheckListIcon;
/** A column chosen from a list. LeftToRightListDashIcon. */
export const ListDashIcon: IconData = LeftToRightListDashIcon;
/** Show as a list. LeftToRightListBulletIcon. */
export const ListIcon: IconData =
  /* @__PURE__ */
  directional(LeftToRightListBulletIcon);
/** Working: drawn turning while something happens. Loading03Icon. */
export const LoaderIcon: IconData = Loading03Icon;
/** Locked: there, but the person cannot open it. SquareLock02Icon. */
export const LockIcon: IconData = SquareLock02Icon;
/** Sign out. Logout03Icon. */
export const LogOutIcon: IconData =
  /* @__PURE__ */
  directional(Logout03Icon);
/** An email. Mail01Icon. */
export const MailIcon: IconData = Mail01Icon;
/** Where something happens: a place. Location01Icon. */
export const MapPinIcon: IconData = Location01Icon;
/** Open bigger: a card's text to its full height or a window. ArrowExpand01Icon. */
export const Maximize2Icon: IconData = ArrowExpand01Icon;
/** A conversation, or open in a chat. BubbleChatIcon. */
export const MessageCircleIcon: IconData = BubbleChatIcon;
/** A conversation shown, its panel open: MessageSquare's own shape filled in the ink, for a choice that stays on. Message01Icon. */
export const MessageSquareFilledIcon: IconData =
  /* @__PURE__ */
  solidForm(Message01Icon);
/** A conversation: the frame's Chat row (the pick). Message01Icon. */
export const MessageSquareIcon: IconData = Message01Icon;
/** Speak instead of typing. Mic01Icon. */
export const MicIcon: IconData = Mic01Icon;
/** Back to its own size: leave full screen, Maximize2Icon's pair. ArrowShrink01Icon. */
export const Minimize2Icon: IconData = ArrowShrink01Icon;
/** Some, not all: a checkbox whose group is partly checked. MinusSignIcon. */
export const MinusIcon: IconData = MinusSignIcon;
/** Follow the system's light or dark. ComputerIcon. */
export const MonitorIcon: IconData = ComputerIcon;
/** Dark. Moon02Icon. */
export const MoonIcon: IconData = Moon02Icon;
/**
 * Someone's pointer, as another person's cursor is drawn on a shared canvas. Cursor02Icon. It
 * points along the line: right to left it turns round, as the pointer does in a right-to-left
 * system, so its tip still leads the name tag that follows it. */
export const MousePointerIcon: IconData =
  /* @__PURE__ */
  directional(Cursor02Icon);
/** Fold or unfold a sidebar. SidebarLeftIcon. */
export const PanelLeftIcon: IconData =
  /* @__PURE__ */
  directional(SidebarLeftIcon);
/** Show or set aside a panel at the end, such as App shell's panels on a phone. SidebarRightIcon. */
export const PanelRightIcon: IconData =
  /* @__PURE__ */
  directional(SidebarRightIcon);
/** Attach a file. Attachment01Icon. */
export const PaperclipIcon: IconData = Attachment01Icon;
/** Pause, its bars filled in the ink: the heavier form, beside other filled marks. PauseIcon. */
export const PauseFilledIcon: IconData =
  /* @__PURE__ */
  solidForm(HugePauseIcon);
/** Pause what is playing. PauseIcon. */
export const PauseIcon: IconData = HugePauseIcon;
/** Edit or rename. PencilEdit02Icon. */
export const PencilIcon: IconData = PencilEdit02Icon;
/**
 * Read only: the person may open and read it, not change it (a document shared to view). Not
 * Lock, which says it cannot be opened at all. Edit's pencil, struck through. EditOff03Icon. */
export const PencilOffIcon: IconData = EditOff03Icon;
/** Play something through once. PlayIcon. */
export const PlayIcon: IconData = HugePlayIcon;
/** Add something new. Add01Icon. */
export const PlusIcon: IconData = Add01Icon;
/** Redo what was undone. Redo02Icon. */
export const RedoIcon: IconData =
  /* @__PURE__ */
  directional(Redo02Icon);
/** Try again, or write the answer again. Refresh01Icon. */
export const RefreshCwIcon: IconData = Refresh01Icon;
/** Two arrows chasing each other round: something that repeats. RepeatIcon. */
export const RepeatIcon: IconData = HugeRepeatIcon;
/** Launch: a first run, a release, a plan put to work. Rocket01Icon. */
export const RocketIcon: IconData = Rocket01Icon;
/** Weighed: a rule, a policy, a fair comparison. ScaleIcon. */
export const ScaleIcon: IconData = HugeScaleIcon;
/** Fit to the view: a canvas or a picture zoomed back to show it whole. FitToScreenIcon. */
export const ScanIcon: IconData = FitToScreenIcon;
/** Search. Search01Icon. */
export const SearchIcon: IconData = Search01Icon;
/** Send a message or an invite. Sent02Icon. */
export const SendIcon: IconData =
  /* @__PURE__ */
  directional(Sent02Icon);
/** A system or a service an action touches. ServerStack01Icon. */
export const ServerIcon: IconData = ServerStack01Icon;
/** Settings. Settings01Icon. */
export const SettingsIcon: IconData = Settings01Icon;
/** Share with people. Share08Icon. */
export const ShareIcon: IconData = Share08Icon;
/** A spreadsheet: a head row over a grid of cells. SheetIcon. */
export const SheetIcon: IconData = HugeSheetIcon;
/** A security warning: a risk, a policy broken. ShieldAlertIcon. */
export const ShieldAlertIcon: IconData = HugeShieldAlertIcon;
/** A thread's or a message's settings. SlidersHorizontalIcon. */
export const SlidersHorizontalIcon: IconData = HugeSlidersHorizontalIcon;
/** A phone's width: shown as on a phone. SmartPhone01Icon. */
export const SmartphoneIcon: IconData = SmartPhone01Icon;
/** Made or suggested by the agent. SparklesIcon. */
export const SparklesIcon: IconData = HugeSparklesIcon;
/** Split into two: a view, a flow laid side by side. SplitIcon. */
export const SplitIcon: IconData = HugeSplitIcon;
/** A column of yes or no. CheckmarkSquare02Icon. */
export const SquareCheckIcon: IconData = CheckmarkSquare02Icon;
/** Stop what is running, such as an answer being written. StopIcon. */
export const SquareIcon: IconData = StopIcon;
/** Favourites. StarIcon. */
export const StarIcon: IconData = HugeStarIcon;
/** A note someone wrote. Note01Icon. */
export const StickyNoteIcon: IconData = Note01Icon;
/** Light. Sun03Icon. */
export const SunIcon: IconData = Sun03Icon;
/** A table of data: a head row over rows. TableIcon. */
export const TableIcon: IconData = HugeTableIcon;
/** A tablet's width: shown as on a tablet. Tablet01Icon. */
export const TabletIcon: IconData = Tablet01Icon;
/** A column of tags. Tag01Icon. */
export const TagIcon: IconData = Tag01Icon;
/** A shell: a command run and what it printed. ComputerTerminal01Icon. */
export const TerminalIcon: IconData = ComputerTerminal01Icon;
/** Text set in the middle. TextAlignCenterIcon. */
export const TextAlignCenterIcon: IconData = HugeTextAlignCenterIcon;
/** Text set to the end. TextAlignRightIcon. */
export const TextAlignEndIcon: IconData =
  /* @__PURE__ */
  directional(TextAlignRightIcon);
/** Text set to the start. TextAlignLeftIcon. */
export const TextAlignStartIcon: IconData =
  /* @__PURE__ */
  directional(TextAlignLeftIcon);
/** A field someone types into: a text input. InputTextIcon. */
export const TextCursorInputIcon: IconData = InputTextIcon;
/** A column of short text. TextIcon. */
export const TextIcon: IconData = HugeTextIcon;
/** A poor answer given: ThumbsDown's own shapes filled in the ink, for an action that stays on. ThumbsDownIcon. */
export const ThumbsDownFilledIcon: IconData =
  /* @__PURE__ */
  solidForm(HugeThumbsDownIcon);
/** A poor answer. ThumbsDownIcon. */
export const ThumbsDownIcon: IconData = HugeThumbsDownIcon;
/** A good answer given: ThumbsUp's own shapes filled in the ink, for an action that stays on. ThumbsUpIcon. */
export const ThumbsUpFilledIcon: IconData =
  /* @__PURE__ */
  solidForm(HugeThumbsUpIcon);
/** A good answer. ThumbsUpIcon. */
export const ThumbsUpIcon: IconData = HugeThumbsUpIcon;
/** Delete. Delete02Icon. */
export const TrashIcon: IconData = Delete02Icon;
/** A figure going down. ChartDecreaseIcon. */
export const TrendingDownIcon: IconData = ChartDecreaseIcon;
/** A figure going up. ChartIncreaseIcon. */
export const TrendingUpIcon: IconData = ChartIncreaseIcon;
/** A warning: something to look at, or something that did not load. Alert02Icon. */
export const TriangleAlertIcon: IconData = Alert02Icon;
/** Words: a title, a name typed in. TextFontIcon. */
export const TypeIcon: IconData = TextFontIcon;
/** Underlined text. TextUnderlineIcon. */
export const UnderlineIcon: IconData = TextUnderlineIcon;
/** Undo the last change. Undo02Icon. */
export const UndoIcon: IconData =
  /* @__PURE__ */
  directional(Undo02Icon);
/** Send a file up: a drop zone, an upload button. Upload01Icon. */
export const UploadIcon: IconData = Upload01Icon;
/** Invite a person. UserAdd01Icon. */
export const UserPlusIcon: IconData = UserAdd01Icon;
/** A person with sparkles: a user that is AI. AiUserIcon. */
export const UserSparklesIcon: IconData = AiUserIcon;
/** People: users, members, customers. UserGroupIcon. */
export const UsersIcon: IconData = UserGroupIcon;
/** A video call. Video01Icon. */
export const VideoIcon: IconData = Video01Icon;
/** Sound on. VolumeHighIcon. */
export const VolumeIcon: IconData = VolumeHighIcon;
/** Sound off. VolumeMute01Icon. */
export const VolumeOffIcon: IconData = VolumeMute01Icon;
/** A wand with sparkles: something done by AI. AiMagicIcon. */
export const WandSparklesIcon: IconData = AiMagicIcon;
/** Squares joined by lines: steps that run in order. WorkflowSquare03Icon. */
export const WorkflowIcon: IconData = WorkflowSquare03Icon;
/** A wrench: a tool, or settings to adjust. Wrench01Icon. */
export const WrenchIcon: IconData = Wrench01Icon;
/** Failed, or close. Cancel01Icon. */
export const XIcon: IconData = Cancel01Icon;
/** Quick, or a power: a shortcut, a skill. ZapIcon. */
export const ZapIcon: IconData = HugeZapIcon;
/** Zoom in. SearchAddIcon. */
export const ZoomInIcon: IconData = SearchAddIcon;
/** Zoom out. SearchMinusIcon. */
export const ZoomOutIcon: IconData = SearchMinusIcon;

/** The mark a file wears for its media type (`image/png`), where it shows no picture. */
export const fileMark = (type: string | undefined): IconData => {
  if (type === undefined) {
    return FileIcon;
  }
  if (type.startsWith("image/")) {
    return ImageIcon;
  }
  if (type.startsWith("video/")) {
    return VideoIcon;
  }
  if (type.startsWith("audio/")) {
    return AudioWaveformIcon;
  }
  return type === "application/pdf" ? FilePdfIcon : FileIcon;
};
