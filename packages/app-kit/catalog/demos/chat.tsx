import {
  AskCard,
  AskCardBody,
  AskCardChoices,
  AskCardFooter,
  AskCardHeader,
  AskCardOption,
  AskCardProgress,
  AskCardQuestion,
  AskCardTopic,
} from "@grasp-os/app-kit/components/ask-card";
// Demos of the kit's chat components. One per component, for the dev-only
// gallery and its accessibility checks (test/kit.browser.test.tsx).
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@grasp-os/app-kit/components/attachment";
import { Avatar, AvatarFallback } from "@grasp-os/app-kit/components/avatar";
import { Badge } from "@grasp-os/app-kit/components/badge";
import {
  Bubble,
  BubbleContent,
  BubbleGroup,
} from "@grasp-os/app-kit/components/bubble";
import { Button } from "@grasp-os/app-kit/components/button";
import { GraspMark } from "@grasp-os/app-kit/components/grasp-mark";
import { InputGroup } from "@grasp-os/app-kit/components/input-group";
import {
  Marker,
  MarkerContent,
  MarkerIcon,
} from "@grasp-os/app-kit/components/marker";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageGroup,
  MessageHeader,
} from "@grasp-os/app-kit/components/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@grasp-os/app-kit/components/message-scroller";
import {
  PromptBar,
  PromptBarAction,
  PromptBarActions,
  PromptBarIcon,
  PromptBarInput,
} from "@grasp-os/app-kit/components/prompt-bar";
import { PromptEditor } from "@grasp-os/app-kit/components/prompt-editor";
import {
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuTrigger,
  PromptInputSubjectBar,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@grasp-os/app-kit/components/prompt-input";
import { RadioGroupItem } from "@grasp-os/app-kit/components/radio-group";
import { Shimmer } from "@grasp-os/app-kit/components/shimmer";
import { Spinner } from "@grasp-os/app-kit/components/spinner";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@grasp-os/app-kit/components/trace";
import {
  BrainIcon,
  CheckIcon,
  CodeIcon,
  FileTextIcon,
  LayoutGridIcon,
  PanelRightOpenIcon,
  UserIcon,
} from "lucide-react";
import { useState } from "react";

const AttachmentDemo = () => (
  <Attachment>
    <AttachmentMedia>
      <FileTextIcon />
    </AttachmentMedia>
    <AttachmentContent>
      <AttachmentTitle>Q3 report.pdf</AttachmentTitle>
      <AttachmentDescription>2.4 MB</AttachmentDescription>
    </AttachmentContent>
  </Attachment>
);

const BubbleDemo = () => (
  <BubbleGroup>
    <Bubble variant="muted">
      <BubbleContent>Can you send the report?</BubbleContent>
    </Bubble>
    <Bubble align="end">
      <BubbleContent>Sent it this morning.</BubbleContent>
    </Bubble>
  </BubbleGroup>
);

const MarkerDemo = () => (
  <Marker render={<output />}>
    <MarkerIcon>
      <Spinner />
    </MarkerIcon>
    <MarkerContent>Thinking</MarkerContent>
  </Marker>
);

const MessageDemo = () => (
  <MessageGroup>
    <Message>
      <MessageAvatar>
        <Avatar>
          <AvatarFallback>MJ</AvatarFallback>
        </Avatar>
      </MessageAvatar>
      <MessageContent>
        <MessageHeader>Maya</MessageHeader>
        <Bubble variant="muted">
          <BubbleContent>The proposal is ready for review.</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  </MessageGroup>
);

const messages = [
  { id: "m1", text: "Hello there!", mine: true },
  { id: "m2", text: "Hi! How can I help?", mine: false },
  { id: "m3", text: "Where is the Q3 report?", mine: true },
  { id: "m4", text: "In Knowledge, under Reports.", mine: false },
];

const MessageScrollerDemo = () => (
  <div className="h-56 rounded-lg border">
    <MessageScrollerProvider>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            {messages.map((message) => (
              <MessageScrollerItem
                key={message.id}
                messageId={message.id}
                scrollAnchor={message.mine}
              >
                <Message align={message.mine ? "end" : "start"}>
                  <Bubble variant={message.mine ? "default" : "muted"}>
                    <BubbleContent>{message.text}</BubbleContent>
                  </Bubble>
                </Message>
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  </div>
);

const AskCardDemo = () => (
  <AskCard aria-label="Grasp asks">
    <AskCardHeader>
      <AskCardTopic>Direction</AskCardTopic>
      <AskCardProgress current={1} total={2}>
        1 of 2
      </AskCardProgress>
    </AskCardHeader>
    <AskCardBody>
      <AskCardQuestion id="ask-card-demo">
        Which direction should the dashboard take?
      </AskCardQuestion>
      <AskCardChoices aria-labelledby="ask-card-demo" defaultValue="0">
        <AskCardOption
          badge={<Badge variant="secondary">Recommended</Badge>}
          control={<RadioGroupItem value="0" />}
          description="Compact KPIs, clear trends, little else"
          shortcut="1"
        >
          Executive
        </AskCardOption>
        <AskCardOption
          control={<RadioGroupItem value="1" />}
          description="More breakdowns and comparisons"
          shortcut="2"
        >
          Analytical
        </AskCardOption>
      </AskCardChoices>
    </AskCardBody>
    <AskCardFooter>
      <Button size="sm" variant="ghost">
        Type instead
      </Button>
      <Button className="ml-auto" size="sm">
        Next
      </Button>
    </AskCardFooter>
  </AskCard>
);

const PromptBarDemo = () => (
  <PromptBar>
    <PromptBarIcon>
      <GraspMark />
    </PromptBarIcon>
    <PromptBarInput aria-label="Ask" placeholder="Ask anything" />
    <PromptBarActions>
      <PromptBarAction aria-label="Open the chat" variant="ghost">
        <PanelRightOpenIcon />
      </PromptBarAction>
    </PromptBarActions>
  </PromptBar>
);

const PromptInputDemo = () => (
  <form
    onSubmit={(event) => {
      event.preventDefault();
    }}
  >
    <InputGroup>
      <PromptInputBody>
        <PromptInputTextarea aria-label="Message" />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <PromptInputActionMenu>
            <PromptInputActionMenuTrigger aria-label="More actions" />
            <PromptInputActionMenuContent>
              <PromptInputActionMenuItem>
                Attach a file
              </PromptInputActionMenuItem>
            </PromptInputActionMenuContent>
          </PromptInputActionMenu>
          <PromptInputButton tooltip="Search the web">Search</PromptInputButton>
        </PromptInputTools>
        <PromptInputSubmit />
      </PromptInputFooter>
    </InputGroup>
  </form>
);

const mentionKinds = {
  app: { label: "Apps", icon: <LayoutGridIcon />, tone: "app" as const },
  person: { label: "People", icon: <UserIcon />, tone: "person" as const },
};

const mentionable = [
  { kind: "app", id: "invoices", label: "Invoices" },
  { kind: "person", id: "ines", label: "Ines", description: "Builder" },
];

const mentionTriggers = [
  {
    char: "@",
    suggest: (query: string) =>
      mentionable.filter(({ label }) =>
        label.toLowerCase().includes(query.toLowerCase())
      ),
    empty: "Nothing found",
  },
];

const PromptEditorDemo = () => {
  const [value, setValue] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <PromptInputSubjectBar>
        <LayoutGridIcon />
        <span>Invoices</span>
      </PromptInputSubjectBar>
      <InputGroup>
        <PromptInputBody>
          <PromptEditor
            kinds={mentionKinds}
            label="Message"
            onChange={({ text }) => {
              setValue(text);
            }}
            onSubmit={() => {
              setValue("");
            }}
            placeholder="Type @ to mention an App or a person"
            triggers={mentionTriggers}
            value={value}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputSubmit />
        </PromptInputFooter>
      </InputGroup>
    </form>
  );
};

const ShimmerDemo = () => (
  <Shimmer aria-live="polite">Thinking about your question…</Shimmer>
);

const TraceDemo = () => (
  <Trace>
    <TraceLine>
      <TraceIcon>
        <CheckIcon />
      </TraceIcon>
      <TraceTitle>Worked for 21s</TraceTitle>
    </TraceLine>
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon>
            <BrainIcon />
          </TraceIcon>
          <TraceTitle>Thought for 4s</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        The invoices are in the finance collection; the overdue ones first.
      </TraceCollapsibleContent>
    </TraceCollapsible>
    <TraceLine status="running">
      <TraceIcon>
        <CodeIcon />
      </TraceIcon>
      <TraceTitle>Reading the invoices</TraceTitle>
      <TraceDescription>2s</TraceDescription>
    </TraceLine>
  </Trace>
);

export const chatDemos = {
  "ask-card": AskCardDemo,
  attachment: AttachmentDemo,
  bubble: BubbleDemo,
  marker: MarkerDemo,
  message: MessageDemo,
  "message-scroller": MessageScrollerDemo,
  "prompt-bar": PromptBarDemo,
  "prompt-editor": PromptEditorDemo,
  "prompt-input": PromptInputDemo,
  shimmer: ShimmerDemo,
  trace: TraceDemo,
};
