// Demos of the kit's chat components. One per component, for the dev-only
// gallery and its accessibility checks (e2e/catalog.e2e.ts).
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@grasp-os/ui/components/attachment";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import {
  Bubble,
  BubbleContent,
  BubbleGroup,
} from "@grasp-os/ui/components/bubble";
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
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@grasp-os/ui/components/prompt-input";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@grasp-os/ui/components/questionnaire";
import { Shimmer } from "@grasp-os/ui/components/shimmer";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { FileTextIcon } from "lucide-react";

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

const questions = [
  {
    name: "next",
    required: true,
    choices: [{ value: "inspect" }, { value: "implement" }],
  },
] as const;

const QuestionnaireDemo = () => (
  <Questionnaire items={questions} defaultItem="next">
    <QuestionnaireItem name="next" required>
      <QuestionnaireTitle>What should happen next?</QuestionnaireTitle>
      <QuestionnaireChoices>
        <QuestionnaireChoice value="inspect">
          Inspect the code
        </QuestionnaireChoice>
        <QuestionnaireChoice value="implement">
          Make the change
        </QuestionnaireChoice>
      </QuestionnaireChoices>
    </QuestionnaireItem>
    <QuestionnaireActions>
      <QuestionnaireNext>Next</QuestionnaireNext>
      <QuestionnaireSubmit>Send</QuestionnaireSubmit>
    </QuestionnaireActions>
  </Questionnaire>
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

const ShimmerDemo = () => (
  <Shimmer aria-live="polite">Thinking about your question…</Shimmer>
);

export const chatDemos = {
  attachment: AttachmentDemo,
  bubble: BubbleDemo,
  "inline-citation": InlineCitationDemo,
  marker: MarkerDemo,
  message: MessageDemo,
  "message-scroller": MessageScrollerDemo,
  "prompt-input": PromptInputDemo,
  questionnaire: QuestionnaireDemo,
  shimmer: ShimmerDemo,
};
