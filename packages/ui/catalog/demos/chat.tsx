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
} from "@grasp-os/ui/components/ask-card";
// Demos of the kit's chat components. One per component, for the dev-only
// gallery and its accessibility checks (test/kit.browser.test.tsx).
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@grasp-os/ui/components/attachment";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Bubble,
  BubbleContent,
  BubbleGroup,
} from "@grasp-os/ui/components/bubble";
import { Button } from "@grasp-os/ui/components/button";
import { GraspMark } from "@grasp-os/ui/components/grasp-mark";
import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationCarousel,
  InlineCitationCarouselContent,
  InlineCitationCarouselHeader,
  InlineCitationCarouselIndex,
  InlineCitationCarouselItem,
  InlineCitationCarouselNext,
  InlineCitationCarouselPrev,
  InlineCitationQuote,
  InlineCitationSource,
  InlineCitationText,
} from "@grasp-os/ui/components/inline-citation";
import { InputGroup } from "@grasp-os/ui/components/input-group";
import {
  Marker,
  MarkerContent,
  MarkerIcon,
} from "@grasp-os/ui/components/marker";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageGroup,
  MessageHeader,
} from "@grasp-os/ui/components/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@grasp-os/ui/components/message-scroller";
import {
  PromptBar,
  PromptBarAction,
  PromptBarActions,
  PromptBarIcon,
  PromptBarInput,
} from "@grasp-os/ui/components/prompt-bar";
import { PromptEditor } from "@grasp-os/ui/components/prompt-editor";
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
} from "@grasp-os/ui/components/prompt-input";
import { RadioGroupItem } from "@grasp-os/ui/components/radio-group";
import { Shimmer } from "@grasp-os/ui/components/shimmer";
import { Spinner } from "@grasp-os/ui/components/spinner";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@grasp-os/ui/components/trace";
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

const InlineCitationDemo = () => (
  <p className="text-sm">
    <InlineCitation>
      <InlineCitationText>
        Invoices are approved within two days
      </InlineCitationText>
      <InlineCitationCard>
        <InlineCitationCardTrigger
          sources={["https://handbook.example.com/finance", "Approval policy"]}
        />
        <InlineCitationCardBody>
          <InlineCitationCarousel>
            <InlineCitationCarouselHeader>
              <InlineCitationCarouselPrev />
              <InlineCitationCarouselNext />
              <InlineCitationCarouselIndex />
            </InlineCitationCarouselHeader>
            <InlineCitationCarouselContent>
              <InlineCitationCarouselItem>
                <InlineCitationSource
                  title="Finance handbook"
                  url="https://handbook.example.com/finance"
                  description="How invoices move from received to paid."
                />
                <InlineCitationQuote>
                  Every invoice is approved within two working days.
                </InlineCitationQuote>
              </InlineCitationCarouselItem>
              <InlineCitationCarouselItem>
                <InlineCitationSource title="Approval policy" />
              </InlineCitationCarouselItem>
            </InlineCitationCarouselContent>
          </InlineCitationCarousel>
        </InlineCitationCardBody>
      </InlineCitationCard>
    </InlineCitation>
    .
  </p>
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
  "inline-citation": InlineCitationDemo,
  marker: MarkerDemo,
  message: MessageDemo,
  "message-scroller": MessageScrollerDemo,
  "prompt-bar": PromptBarDemo,
  "prompt-editor": PromptEditorDemo,
  "prompt-input": PromptInputDemo,
  shimmer: ShimmerDemo,
  trace: TraceDemo,
};
