// The icons of Grasp UI: one entry point for the whole system. Every icon is a Hugeicons drawing,
// renamed to what it means in the product, so a component asks for `Tick`, not for
// `Tick02Icon`. Add an icon here (with its Hugeicons name in the comment) before using it.
//
//   import { Icon, Plus } from "../../icons";
//   <Icon icon={Plus} />            beside words
//   <Icon icon={Plus} label="Add" />  standing alone, with a name
import {
  Add01Icon,
  Agreement01Icon,
  AiMagicIcon,
  Alert02Icon,
  AlertCircleIcon,
  Analytics01Icon,
  AppWindowIcon,
  AppleIcon,
  Archive02Icon,
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowLeft01Icon,
  ArrowLeft02Icon,
  ArrowLeftRightIcon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowUp02Icon,
  ArrowUpDownIcon,
  ArrowUpRight01Icon,
  Attachment01Icon,
  BubbleChatIcon,
  CableIcon,
  Calendar03Icon,
  Cancel01Icon,
  ChartDecreaseIcon,
  ChartIncreaseIcon,
  ChartLineData01Icon,
  ChatGptIcon,
  CheckListIcon,
  CheckmarkCircle02Icon,
  CheckmarkSquare02Icon,
  CircleIcon,
  ClaudeIcon,
  Clock01Icon,
  Coins01Icon,
  ComputerIcon,
  ContrastIcon,
  Copy01Icon,
  DashboardSquare01Icon,
  Delete02Icon,
  DiscordIcon,
  Doc01Icon,
  Dollar01Icon,
  Download01Icon,
  DropboxIcon,
  FacebookIcon,
  FigmaIcon,
  File01Icon,
  FileEditIcon,
  Folder01Icon,
  FolderKanbanIcon,
  GithubIcon,
  Globe02Icon,
  GoBackward10SecIcon,
  GoForward10SecIcon,
  GoogleDocIcon,
  GoogleDriveIcon,
  GoogleGeminiIcon,
  GoogleIcon,
  GoogleSheetIcon,
  GridViewIcon,
  HashtagIcon,
  HelpCircleIcon,
  Home01Icon,
  Idea01Icon,
  Image01Icon,
  InboxIcon,
  InformationCircleIcon,
  InstagramIcon,
  LeftToRightListBulletIcon,
  LeftToRightListDashIcon,
  Link04Icon,
  LinkedinIcon,
  Loading03Icon,
  Logout03Icon,
  Menu02Icon,
  Mic01Icon,
  MicrosoftIcon,
  MicrosoftTeamsIcon,
  MinusSignCircleIcon,
  MinusSignIcon,
  Moon02Icon,
  MoreHorizontalIcon,
  NewTwitterIcon,
  Notification03Icon,
  NotionIcon,
  PauseIcon,
  Pdf01Icon,
  PencilEdit02Icon,
  PercentIcon,
  PerplexityAiIcon,
  PlayIcon,
  Redo02Icon,
  RefreshIcon,
  RepeatIcon,
  Route02Icon,
  Search01Icon,
  Sent02Icon,
  ServerStack01Icon,
  Settings01Icon,
  ShopifyIcon,
  SidebarLeftIcon,
  SlackIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  StarIcon,
  StopIcon,
  StripeIcon,
  Sun03Icon,
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
  TrelloIcon,
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
  WhatsappIcon,
  Wrench01Icon,
  YoutubeIcon,
  ZapIcon,
  ZoomIcon,
} from "@hugeicons/core-free-icons";

import { pointing } from "./icon";
import type { IconData } from "./icon";

export { Icon, type IconData, type IconProps } from "./icon";
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

// Brand icons (cloud/pickers): other companies' marks, for integrations, sources and sign-in.
// Hugeicons draws each as a line mark in the text colour; a mark is never recoloured or redrawn.
/** Google. GoogleIcon. */
export const BrandGoogle: IconData = GoogleIcon;
/** Google Drive. GoogleDriveIcon. */
export const BrandGoogleDrive: IconData = GoogleDriveIcon;
/** Google Docs. GoogleDocIcon. */
export const BrandGoogleDocs: IconData = GoogleDocIcon;
/** Google Sheets. GoogleSheetIcon. */
export const BrandGoogleSheets: IconData = GoogleSheetIcon;
/** Gemini. GoogleGeminiIcon. */
export const BrandGemini: IconData = GoogleGeminiIcon;
/** Slack. SlackIcon. */
export const BrandSlack: IconData = SlackIcon;
/** LinkedIn. LinkedinIcon. */
export const BrandLinkedIn: IconData = LinkedinIcon;
/** GitHub. GithubIcon. */
export const BrandGitHub: IconData = GithubIcon;
/** Figma. FigmaIcon. */
export const BrandFigma: IconData = FigmaIcon;
/** Notion. NotionIcon. */
export const BrandNotion: IconData = NotionIcon;
/** Microsoft. MicrosoftIcon. */
export const BrandMicrosoft: IconData = MicrosoftIcon;
/** Microsoft Teams. MicrosoftTeamsIcon. */
export const BrandTeams: IconData = MicrosoftTeamsIcon;
/** Zoom. ZoomIcon. */
export const BrandZoom: IconData = ZoomIcon;
/** WhatsApp. WhatsappIcon. */
export const BrandWhatsApp: IconData = WhatsappIcon;
/** ChatGPT. ChatGptIcon. */
export const BrandChatGpt: IconData = ChatGptIcon;
/** Perplexity. PerplexityAiIcon. */
export const BrandPerplexity: IconData = PerplexityAiIcon;
/** Claude. ClaudeIcon. */
export const BrandClaude: IconData = ClaudeIcon;
/** Apple. AppleIcon. */
export const BrandApple: IconData = AppleIcon;
/** Dropbox. DropboxIcon. */
export const BrandDropbox: IconData = DropboxIcon;
/** Trello. TrelloIcon. */
export const BrandTrello: IconData = TrelloIcon;
/** Stripe. StripeIcon. */
export const BrandStripe: IconData = StripeIcon;
/** Discord. DiscordIcon. */
export const BrandDiscord: IconData = DiscordIcon;
/** YouTube. YoutubeIcon. */
export const BrandYouTube: IconData = YoutubeIcon;
/** X, formerly Twitter. NewTwitterIcon. */
export const BrandX: IconData = NewTwitterIcon;
/** Instagram. InstagramIcon. */
export const BrandInstagram: IconData = InstagramIcon;
/** Facebook. FacebookIcon. */
export const BrandFacebook: IconData = FacebookIcon;
/** Shopify. ShopifyIcon. */
export const BrandShopify: IconData = ShopifyIcon;

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
// The app frame's sidebar and profile menu (Ruben's frame, ported by builder 1).
/** A chat with an agent: the frame's Chat row. SparklesIcon. */
export const Sparkle: IconData = SparklesIcon;
/** What the workspace knows, joined up: the frame's Brain row. Route02Icon. */
export const Waypoints: IconData = Route02Icon;
/** Projects, as a board in a folder. FolderKanbanIcon. */
export const Projects: IconData = FolderKanbanIcon;
/** Apps, as panels on a page. DashboardSquare01Icon. */
export const AppPanels: IconData = DashboardSquare01Icon;
/** Something that runs again and again: workflows. RepeatIcon. */
export const Cycle: IconData = RepeatIcon;
/** Agents that help: a hand given. Agreement01Icon. */
export const Helping: IconData = Agreement01Icon;
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
