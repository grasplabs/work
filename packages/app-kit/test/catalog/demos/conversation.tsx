// Demos of the kit's components for conversations and the work behind
// them: messages in bubbles, their attachments, markers, a trace of steps,
// code and a model's answer in Markdown. One per component, for the kit's accessibility checks
// (test/kit.browser.test.tsx).
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentTitle,
} from "@grasp-os/app-kit/components/attachment";
import { Bubble, BubbleContent } from "@grasp-os/app-kit/components/bubble";
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@grasp-os/app-kit/components/code-block";
import { Markdown } from "@grasp-os/app-kit/components/markdown";
import {
  Marker,
  MarkerContent,
  MarkerIcon,
} from "@grasp-os/app-kit/components/marker";
import { Message, MessageContent } from "@grasp-os/app-kit/components/message";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@grasp-os/app-kit/components/message-scroller";
import {
  Trace,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@grasp-os/app-kit/components/trace";
import { useHighlightedCode } from "@grasp-os/app-kit/hooks/use-highlighted-code";
import { FileTextIcon, SearchIcon, XIcon } from "lucide-react";

const AttachmentDemo = () => (
  <Attachment className="w-full">
    <AttachmentContent>
      <AttachmentTitle>Invoice 2026-1184.pdf</AttachmentTitle>
      <AttachmentDescription>212 KB</AttachmentDescription>
    </AttachmentContent>
    <AttachmentActions>
      <AttachmentAction aria-label="Remove Invoice 2026-1184.pdf">
        <XIcon />
      </AttachmentAction>
    </AttachmentActions>
  </Attachment>
);

const BubbleDemo = () => (
  <div className="flex flex-col gap-4">
    <Bubble>
      <BubbleContent>Is the March invoice paid?</BubbleContent>
    </Bubble>
    <Bubble align="end" variant="secondary">
      <BubbleContent>Yes, on the 4th.</BubbleContent>
    </Bubble>
  </div>
);

const source = `const total = invoices
  .filter((invoice) => invoice.paid)
  .reduce((sum, invoice) => sum + invoice.amount, 0);`;

const CodeBlockDemo = () => {
  const lines = useHighlightedCode(source, "ts");
  return (
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>total.ts</CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers>
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
};

const answer = `Two invoices are **overdue**:

| Supplier | Days late |
| --- | --- |
| Kantoorhuis Utrecht | 12 |
| Drukkerij Noord | 3 |

\`\`\`ts
const overdue = invoices.filter((invoice) => invoice.due < today);
\`\`\`
`;

// A model's answer in a ghost bubble, as the registry's message-markdown
// example shows it.
const MarkdownDemo = () => (
  <div className="flex flex-col gap-6">
    <Message align="end">
      <MessageContent>
        <Bubble>
          <BubbleContent>Which invoices are overdue?</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
    <Message>
      <MessageContent>
        <Bubble variant="ghost">
          <BubbleContent>
            <Markdown>{answer}</Markdown>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  </div>
);

const MarkerDemo = () => (
  <div className="flex flex-col gap-4">
    <Marker variant="border">
      <MarkerIcon>
        <SearchIcon />
      </MarkerIcon>
      <MarkerContent>Reviewed 8 invoices</MarkerContent>
    </Marker>
    <Marker variant="separator">
      <MarkerContent>Worked for 42s</MarkerContent>
    </Marker>
  </div>
);

const MessageDemo = () => (
  <div className="flex flex-col gap-6">
    <Message align="end">
      <MessageContent>
        <Bubble>
          <BubbleContent>Which supplier is overdue?</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
    <Message>
      <MessageContent>
        <Bubble variant="muted">
          <BubbleContent>Kantoorhuis Utrecht, by 12 days.</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  </div>
);

const turns = [
  { id: "1", text: "Summarise this week's invoices." },
  { id: "2", text: "Six arrived, two are paid, four wait for approval." },
  { id: "3", text: "Who approves them?" },
];

const MessageScrollerDemo = () => (
  <div className="h-48 rounded-lg border">
    <MessageScrollerProvider>
      <MessageScroller>
        <MessageScrollerViewport aria-label="Conversation">
          <MessageScrollerContent>
            {turns.map((turn) => (
              <MessageScrollerItem key={turn.id}>
                <Bubble variant="muted">
                  <BubbleContent>{turn.text}</BubbleContent>
                </Bubble>
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScroller>
    </MessageScrollerProvider>
  </div>
);

const TraceDemo = () => (
  <Trace>
    <TraceLine status="running">
      <TraceIcon>
        <SearchIcon />
      </TraceIcon>
      <TraceTitle>Reading 6 invoices</TraceTitle>
    </TraceLine>
    <TraceLine>
      <TraceIcon>
        <FileTextIcon />
      </TraceIcon>
      <TraceTitle>Opened the approval policy</TraceTitle>
    </TraceLine>
  </Trace>
);

export const conversationDemos = {
  attachment: AttachmentDemo,
  bubble: BubbleDemo,
  "code-block": CodeBlockDemo,
  markdown: MarkdownDemo,
  marker: MarkerDemo,
  message: MessageDemo,
  "message-scroller": MessageScrollerDemo,
  trace: TraceDemo,
};
