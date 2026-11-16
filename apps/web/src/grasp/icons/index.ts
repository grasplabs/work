// The icons of Grasp UI: one entry point for the whole system. Every icon is a Hugeicons drawing,
// renamed to what it means in the product, so a component asks for `Tick`, not for
// `Tick02Icon`. Add an icon here (with its Hugeicons name in the comment) before using it.
//
//   import { Icon, Plus } from "../../icons";
//   <Icon icon={Plus} />            beside words
//   <Icon icon={Plus} label="Add" />  standing alone, with a name
import {
  Add01Icon,
  AiBrain01Icon,
  AiMagicIcon,
  AiUserIcon,
  Alert02Icon,
  AlertCircleIcon,
  Analytics01Icon,
  AppWindowIcon,
  Archive02Icon,
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowExpand01Icon,
  ArrowLeft01Icon,
  ArrowLeft02Icon,
  ArrowLeftRightIcon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  ArrowUpDownIcon,
  ArrowUpRight01Icon,
  Attachment01Icon,
  AudioWave01Icon,
  BubbleChatAddIcon,
  BubbleChatIcon,
  Building03Icon,
  CableIcon,
  Calendar03Icon,
  Cancel01Icon,
  ChartDecreaseIcon,
  ChartIncreaseIcon,
  ChartLineData01Icon,
  CheckListIcon,
  CheckmarkCircle02Icon,
  CheckmarkSquare02Icon,
  CircleIcon,
  Clock01Icon,
  Coins01Icon,
  ComputerIcon,
  ContrastIcon,
  Copy01Icon,
  Cursor02Icon,
  DashboardSquare01Icon,
  Database01Icon,
  Delete02Icon,
  Doc01Icon,
  Dollar01Icon,
  Download01Icon,
  File01Icon,
  FileEditIcon,
  FitToScreenIcon,
  Folder01Icon,
  FolderKanbanIcon,
  Globe02Icon,
  GlobeIcon,
  GoBackward10SecIcon,
  GoForward10SecIcon,
  GridViewIcon,
  HashtagIcon,
  HelpCircleIcon,
  Home01Icon,
  Idea01Icon,
  Image01Icon,
  InboxIcon,
  InformationCircleIcon,
  InputTextIcon,
  Invoice01Icon,
  KeyboardIcon,
  LaptopIcon,
  LeftToRightListBulletIcon,
  LeftToRightListDashIcon,
  Link04Icon,
  Loading03Icon,
  Logout03Icon,
  Mail01Icon,
  Menu02Icon,
  Message01Icon,
  Mic01Icon,
  MinusSignCircleIcon,
  MinusSignIcon,
  Moon02Icon,
  MoreHorizontalIcon,
  Note01Icon,
  Notification03Icon,
  PauseIcon,
  Pdf01Icon,
  PencilEdit02Icon,
  PercentIcon,
  PlayIcon,
  Redo02Icon,
  RefreshIcon,
  RepeatIcon,
  Search01Icon,
  SearchAddIcon,
  SearchMinusIcon,
  Sent02Icon,
  ServerStack01Icon,
  Settings01Icon,
  Share08Icon,
  SidebarLeftIcon,
  SidebarRightIcon,
  SlidersHorizontalIcon,
  SmartPhone01Icon,
  SourceCodeIcon,
  SquareLock02Icon,
  StarIcon,
  StopIcon,
  Sun03Icon,
  Table01Icon,
  Tablet01Icon,
  Tag01Icon,
  Task01Icon,
  TextAlignCenterIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
  TextBoldIcon,
  TextFontIcon,
  TextIcon,
  TextItalicIcon,
  TextUnderlineIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  Tick02Icon,
  Undo02Icon,
  UnfoldMoreIcon,
  Upload01Icon,
  UserAdd01Icon,
  UserCircleIcon,
  UserGroupIcon,
  ViewIcon,
  ViewOffSlashIcon,
  VolumeHighIcon,
  VolumeMute01Icon,
  WorkflowSquare03Icon,
  Wrench01Icon,
  ZapIcon,
} from "@hugeicons/core-free-icons";

import type { IconData } from "./icon";
import { pointing } from "./icon";

export { Icon, type IconData, type IconProps } from "./icon";
// Brand icons: other companies' own marks, filled and in their colours (brands.ts).
export * from "./brands";
// The size and stroke variables live in ./icon.stylex.ts and are imported from there: StyleX
// only resolves variables imported straight from a .stylex.ts file.

/** Add something new. Add01Icon. */
export const Plus: IconData = Add01Icon;
/** Go on to the next step. ArrowRight02Icon: an arrow with a stem, never a chevron. */
export const ArrowRight: IconData = pointing(ArrowRight02Icon);
/** Go back a step. ArrowLeft02Icon. */
export const ArrowLeft: IconData = pointing(ArrowLeft02Icon);
/** A conversation, or open in a chat. BubbleChatIcon. */
export const Chat: IconData = BubbleChatIcon;
/** Follow the system's light or dark. ComputerIcon. */
export const Computer: IconData = ComputerIcon;
/** A link to a place, or copy its address. Link04Icon. */
export const Link: IconData = Link04Icon;
/** Open the menu. Menu02Icon. */
export const Menu: IconData = Menu02Icon;
/** Dark. Moon02Icon. */
export const Moon: IconData = Moon02Icon;
/** Play something through once. PlayIcon. */
export const Play: IconData = PlayIcon;
/** Search. Search01Icon. */
export const Search: IconData = Search01Icon;

/** Every language, or the world: the language switch's button. GlobeIcon. */
export const Globe: IconData = GlobeIcon;
/** Light. Sun03Icon. */
export const Sun: IconData = Sun03Icon;
/** Bold text. TextBoldIcon. */
export const Bold: IconData = TextBoldIcon;
/** Copy to the clipboard. Copy01Icon. */
export const Copy: IconData = Copy01Icon;
/** Failed, or close. Cancel01Icon. */
export const Cross: IconData = Cancel01Icon;
/** Download a file. Download01Icon. */
export const Download: IconData = Download01Icon;
/** More actions, in a menu. MoreHorizontalIcon. */
export const More: IconData = MoreHorizontalIcon;
/** Send a message or an invite. Sent02Icon. */
export const Send: IconData = pointing(Sent02Icon);
/** Settings. Settings01Icon. */
export const Settings: IconData = Settings01Icon;
/** Working: drawn turning while something happens. Loading03Icon. */
export const Spinner: IconData = Loading03Icon;
/** Done. Tick02Icon. */
export const Tick: IconData = Tick02Icon;
/** Delete. Delete02Icon. */
export const Trash: IconData = Delete02Icon;
/** Invite a person. UserAdd01Icon. */
export const UserAdd: IconData = UserAdd01Icon;
/** Some, not all: a checkbox whose group is partly checked. MinusSignIcon. */
export const Minus: IconData = MinusSignIcon;
/** Opens a list below its control: a select, a menu. ArrowDown01Icon: a chevron, never an arrow. */
export const ChevronDown: IconData = ArrowDown01Icon;
/** Show what is hidden, like a password. ViewIcon. */
export const Show: IconData = ViewIcon;
/** Hide it again. ViewOffSlashIcon. */
export const Hide: IconData = ViewOffSlashIcon;
/** Nothing here yet: an empty list or inbox. InboxIcon. */
export const Inbox: IconData = InboxIcon;
/** A warning: something to look at, or something that did not load. Alert02Icon. */
export const Alert: IconData = Alert02Icon;
/** Something to know: a note, an explanation. InformationCircleIcon. */
export const Info: IconData = InformationCircleIcon;
/** It went well: done, ready. CheckmarkCircle02Icon. */
export const Done: IconData = CheckmarkCircle02Icon;
/** It went wrong: an error that stops something. AlertCircleIcon. */
export const Failed: IconData = AlertCircleIcon;
/** A step back: Previous, in a pagination. ArrowLeft01Icon. */
export const ChevronLeft: IconData = pointing(ArrowLeft01Icon);
/** A step on: Next, in a pagination. ArrowRight01Icon. */
export const ChevronRight: IconData = pointing(ArrowRight01Icon);

// Table (cloud/data): the sort of a column.
/** A column sorted from low to high. ArrowUp02Icon. */
export const SortUp: IconData = ArrowUp02Icon;
/** A column sorted from high to low. ArrowDown02Icon. */
export const SortDown: IconData = ArrowDown02Icon;
/** A column that can be sorted, and is not. ArrowUpDownIcon. */
export const Sortable: IconData = ArrowUpDownIcon;
// Button group (cloud builder 6). Italic and Underline came from another builder.
/** Italic text. TextItalicIcon. */
export const Italic: IconData = TextItalicIcon;
/** Underlined text. TextUnderlineIcon. */
export const Underline: IconData = TextUnderlineIcon;
/** Put away, out of the list: Archive. Archive02Icon. */
export const Archive: IconData = Archive02Icon;
/** Show as a list. LeftToRightListBulletIcon. */
export const ListView: IconData = pointing(LeftToRightListBulletIcon);
/** Show as a grid. GridViewIcon. */
export const GridView: IconData = GridViewIcon;
/** Undo the last change. Undo02Icon. */
export const Undo: IconData = pointing(Undo02Icon);
/** Redo what was undone. Redo02Icon. */
export const Redo: IconData = pointing(Redo02Icon);

// Item (cloud builder 6).
/** A folder or a project that holds files. Folder01Icon. */
export const Folder: IconData = Folder01Icon;
/** Text set to the start. TextAlignLeftIcon. */
export const AlignStart: IconData = pointing(TextAlignLeftIcon);
/** Text set in the middle. TextAlignCenterIcon. */
export const AlignCentre: IconData = TextAlignCenterIcon;
/** Text set to the end. TextAlignRightIcon. */
export const AlignEnd: IconData = pointing(TextAlignRightIcon);

// Table (cloud/data): the sort of a column.
// Button group (cloud builder 6). Italic and Underline came from another builder. Archive is in
// the Dropdown menu block below.

// Item (cloud builder 6).

// Dropdown menu's examples.
/** Notifications. Notification03Icon. */
export const Bell: IconData = Notification03Icon;
/** Edit or rename. PencilEdit02Icon. */
export const Edit: IconData = PencilEdit02Icon;
/** Sign out. Logout03Icon. */
export const SignOut: IconData = pointing(Logout03Icon);

// Date picker (cloud/data): the button that opens a calendar.
/** Opens a calendar to choose a date. Calendar03Icon. */
export const CalendarIcon: IconData = Calendar03Icon;

// Highlights and Audio player (cloud/pickers).
/** A figure going up. ChartIncreaseIcon. */
export const TrendUp: IconData = ChartIncreaseIcon;
/** A figure going down. ChartDecreaseIcon. */
export const TrendDown: IconData = ChartDecreaseIcon;
/** People: users, members, customers. UserGroupIcon. */
export const People: IconData = UserGroupIcon;
/** Money: revenue, spend, a price. Coins01Icon. */
export const Money: IconData = Coins01Icon;
/** Pause what is playing. PauseIcon. */
export const Pause: IconData = PauseIcon;
/** Sound on. VolumeHighIcon. */
export const Volume: IconData = VolumeHighIcon;
/** Sound off. VolumeMute01Icon. */
export const Muted: IconData = VolumeMute01Icon;
/** Go back 10 seconds. GoBackward10SecIcon. */
export const Back10: IconData = GoBackward10SecIcon;
/** Go forward 10 seconds. GoForward10SecIcon. */
export const Forward10: IconData = GoForward10SecIcon;

// Sidebar (cloud builder 6).
/** Fold or unfold a sidebar. SidebarLeftIcon. */
export const SidebarToggle: IconData = pointing(SidebarLeftIcon);
/** Show or set aside a panel at the end, such as App shell's panels on a phone. SidebarRightIcon. */
export const PanelToggle: IconData = pointing(SidebarRightIcon);
/** The first page, a workspace's home. Home01Icon. */
export const Home: IconData = Home01Icon;
/** Reports and figures. Analytics01Icon. */
export const Chart: IconData = Analytics01Icon;
/** Tasks, a to-do list. Task01Icon. */
export const Tasks: IconData = Task01Icon;
// Dropdown menu's examples.
// Date picker (cloud/data): the button that opens a calendar.

// Composer, Audio player and Highlights (cloud builder 7).
/** Send a message up into the conversation. ArrowUp02Icon. */
export const ArrowUp: IconData = ArrowUp02Icon;
/** Stop what is running, such as an answer being written. StopIcon. */
export const Stop: IconData = StopIcon;
/** Speak instead of typing. Mic01Icon. */
export const Mic: IconData = Mic01Icon;
/** Listening: dictation is on and hearing you. AudioWave01Icon. */
export const Listening: IconData = AudioWave01Icon;
/** Attach a file. Attachment01Icon. */
export const Attach: IconData = Attachment01Icon;
/** A file. File01Icon. */
export const File: IconData = File01Icon;

// Restored on 13 November: a merge into the showcase branch dropped these blocks, which Table,
// Button group and Item use. Table's sorting (cloud builder 4).
// Button group and Item (cloud builder 6).
// Date picker (cloud/data): the button that opens a calendar. Restored as above.
/** A person: an owner, an assignee. UserCircleIcon. */
export const Person: IconData = UserCircleIcon;
/** A number that is measured: views, a score. ChartLineData01Icon. */
export const Measure: IconData = ChartLineData01Icon;
/** Words: a title, a name typed in. TextFontIcon. */
export const Words: IconData = TextFontIcon;

// Restored on 13 November: a merge into the showcase branch dropped these blocks, which Table,
// Button group and Item use. Table's sorting (cloud builder 4).
// ArrowUp02Icon is imported once, with the Composer's icons above.
// Button group and Item (cloud builder 6).
// Restored (cloud builder 8): the cloud builders' icons, dropped from this file in a showcase merge
// while their components still use them. Archive is above, with the dropdown menu's icons.

// Agent activity and Sources (cloud/pickers).
/** A thought: the agent reasoning. Idea01Icon. */
export const Thought: IconData = Idea01Icon;
/** A tool the agent called. Wrench01Icon. */
export const Tool: IconData = Wrench01Icon;
/** A file changed. FileEditIcon. */
export const FileChanged: IconData = FileEditIcon;
/** A step left out. MinusSignCircleIcon. */
export const Skipped: IconData = MinusSignCircleIcon;
/** A step still to come. CircleIcon. */
export const Waiting: IconData = CircleIcon;
/** The web: a page or a site. Globe02Icon. */
export const Web: IconData = Globe02Icon;
/** A PDF file. Pdf01Icon. */
export const Pdf: IconData = Pdf01Icon;
/** A document. Doc01Icon. */
export const Doc: IconData = Doc01Icon;
// Chat message (cloud builder 7).
/** A good answer. ThumbsUpIcon. */
export const ThumbsUp: IconData = ThumbsUpIcon;
/** A poor answer. ThumbsDownIcon. */
export const ThumbsDown: IconData = ThumbsDownIcon;
/** Try again, or write the answer again. RefreshIcon. */
export const Retry: IconData = RefreshIcon;
// Approval request (cloud builder 6).
/** A system or a service an action touches. ServerStack01Icon. */
export const System: IconData = ServerStack01Icon;
/** Time ran out: an expired request. Clock01Icon. */
export const Clock: IconData = Clock01Icon;
/** Replaced by a newer one: a superseded request. RefreshIcon. */
export const Replaced: IconData = RefreshIcon;
/** An agent: what asks, works and acts. AiMagicIcon. */
export const Agent: IconData = AiMagicIcon;
// Link (cloud builder 10): the mark after a link that leaves the product. ArrowUpRight01Icon is
// imported once, with the Composer's icons above.
/** A link that opens another site, in a new tab. ArrowUpRight01Icon. */
export const External: IconData = pointing(ArrowUpRight01Icon);

// Thread (cloud/pickers): "Jump to latest". ArrowDown02Icon is imported once, with Table's above.
/** Down to the latest: a thread's jump. ArrowDown02Icon. */
export const ArrowDown: IconData = ArrowDown02Icon;
// File upload (builder 1): the drop zone's mark.
/** Send a file up: a drop zone, an upload button. Upload01Icon. */
export const Upload: IconData = Upload01Icon;

// Composer footer (cloud builder 7).
/** Favourites. StarIcon. */
export const Star: IconData = StarIcon;
/** A thread's or a message's settings. SlidersHorizontalIcon. */
export const Sliders: IconData = SlidersHorizontalIcon;
// Composer attachments and mentions (cloud builder 7).
/** An image or a picture. Image01Icon. */
export const Image: IconData = Image01Icon;
/** A skill an agent can use. ZapIcon. */
export const Skill: IconData = ZapIcon;
/** A step up: the section before, in a viewer. ArrowUp01Icon. */
export const ChevronUp: IconData = ArrowUp01Icon;
/** The keyboard: the list of shortcuts. KeyboardIcon. */
export const Keyboard: IconData = KeyboardIcon;
/** Fit to the width: a viewer's zoom back to fit. FitToScreenIcon. */
export const Fit: IconData = FitToScreenIcon;
/** Zoom in. SearchAddIcon. */
export const ZoomIn: IconData = SearchAddIcon;
/** Zoom out. SearchMinusIcon. */
export const ZoomOut: IconData = SearchMinusIcon;
// Artifact viewer comments (artifact viewer step 4).
/** Comments: a viewer's panel of them. BubbleChatIcon. */
export const Comment: IconData = BubbleChatIcon;
/** Add a comment on what is selected. BubbleChatAddIcon. */
export const CommentAdd: IconData = BubbleChatAddIcon;
// The app frame's sidebar and profile menu (Ruben's frame, ported by builder 1).
/** A conversation: the frame's Chat row (Ruben's pick). Message01Icon. */
export const Conversation: IconData = Message01Icon;
/** What the workspace knows: the frame's Brain row (Ruben's pick). AiBrain01Icon. */
export const Brain: IconData = AiBrain01Icon;
/** Projects, as a board in a folder. FolderKanbanIcon. */
export const Projects: IconData = FolderKanbanIcon;
/** Apps, as panels on a page. DashboardSquare01Icon. */
export const AppPanels: IconData = DashboardSquare01Icon;
/** Something that runs again and again: workflows. RepeatIcon. */
export const Cycle: IconData = RepeatIcon;
/** Agents, people that are AI: the frame's Agents row (Ruben's pick). AiUserIcon. */
export const AgentPerson: IconData = AiUserIcon;
/** Integrations: a cable that connects. CableIcon. */
export const Cable: IconData = CableIcon;
/** One app, as a window. AppWindowIcon. */
export const AppWindow: IconData = AppWindowIcon;
/** Switching to another account or workspace. ArrowLeftRightIcon. */
export const Swap: IconData = ArrowLeftRightIcon;
/** A menu that opens up and down from where it stands (a profile's). UnfoldMoreIcon. */
export const UpDown: IconData = UnfoldMoreIcon;
/** Light and dark: the theme. ContrastIcon. */
export const Contrast: IconData = ContrastIcon;
/** A list of steps to do: a tour, a checklist. CheckListIcon. */
export const Checklist: IconData = CheckListIcon;
/** Help, as a question. HelpCircleIcon. */
export const Question: IconData = HelpCircleIcon;

// Data grid column kinds (cloud builder 7).
/** A column of short text. TextIcon. */
export const KindText: IconData = TextIcon;
/** A column of numbers. HashtagIcon. */
export const KindNumber: IconData = HashtagIcon;
/** A column of money. Dollar01Icon. */
export const KindCurrency: IconData = Dollar01Icon;
/** A column of percentages. PercentIcon. */
export const KindPercent: IconData = PercentIcon;
/** A column chosen from a list. LeftToRightListDashIcon. */
export const KindSelect: IconData = LeftToRightListDashIcon;
/** A column of yes or no. CheckmarkSquare02Icon. */
export const KindCheckbox: IconData = CheckmarkSquare02Icon;
/** A column of tags. Tag01Icon. */
export const KindTag: IconData = Tag01Icon;

// Inspector panel (cloud builder 4): the marks of what a row in a panel's card is. Lock and Mail
// are the sources' (cloud builder 10), below.
/** A tag or a category. Tag01Icon. */
export const Tag: IconData = Tag01Icon;
/** Open bigger: a card's text to its full height or a window. ArrowExpand01Icon. */
export const Expand: IconData = ArrowExpand01Icon;
/** Share with people. Share08Icon. */
export const Share: IconData = Share08Icon;
/** A company or an organisation. Building03Icon. */
export const Company: IconData = Building03Icon;
/** A note someone wrote. Note01Icon. */
export const Note: IconData = Note01Icon;
/** A field someone types into: a text input. InputTextIcon. */
export const TextInput: IconData = InputTextIcon;
/** A source of records: a table, a database. Database01Icon. */
export const Database: IconData = Database01Icon;
// Sources of every kind (cloud builder 10): the marks a source's kind wears.
/** A workflow: steps that run in order, by a schedule or a trigger. WorkflowSquare03Icon. */
export const Workflow: IconData = WorkflowSquare03Icon;
/** A table or a query: rows of data. Table01Icon. */
export const Rows: IconData = Table01Icon;
/** Code: a file of source, some of its lines. SourceCodeIcon. */
export const Code: IconData = SourceCodeIcon;
/** A record in an app: a deal, a ticket, an invoice. Invoice01Icon. */
export const AppRecord: IconData = Invoice01Icon;
/** An email. Mail01Icon. */
export const Mail: IconData = Mail01Icon;
/** Locked: there, but the person cannot open it. SquareLock02Icon. */
export const Lock: IconData = SquareLock02Icon;
/**
 * Someone's pointer, as another person's cursor is drawn on a shared canvas. Cursor02Icon. It
 * points along the line: right to left it turns round, as the pointer does in a right-to-left
 * system, so its tip still leads the name tag that follows it.
 */
export const Pointer: IconData = pointing(Cursor02Icon);
// App preview: the widths a running app is shown at.
/** A phone's width: an app shown as on a phone. SmartPhone01Icon. */
export const Phone: IconData = SmartPhone01Icon;
/** A tablet's width: an app shown as on a tablet. Tablet01Icon. */
export const Tablet: IconData = Tablet01Icon;
/** A desktop's width: an app shown as on a laptop or a desktop. LaptopIcon. */
export const Desktop: IconData = LaptopIcon;
