// A specialised panel: the main work on one side and an inspector for the
// selected record on the other, with tabs for its details and its history.
// The two stack on a phone; the inspector scrolls on its own.
import { Badge } from "@grasp-os/app-kit/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@grasp-os/app-kit/components/card";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@grasp-os/app-kit/components/progress";
import { ScrollArea } from "@grasp-os/app-kit/components/scroll-area";
import { Separator } from "@grasp-os/app-kit/components/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/app-kit/components/tabs";

const details = [
  { label: "Owner", value: "Maya Jansen" },
  { label: "Region", value: "Benelux" },
  { label: "Renewal", value: "1 March" },
];

const history = [
  { id: "h3", when: "Today", what: "Moved to Negotiation" },
  { id: "h2", when: "Monday", what: "Sent the proposal" },
  { id: "h1", when: "Last week", what: "First call" },
];

export const SpecialisedPanelExample = () => (
  <div className="flex min-w-0 flex-col gap-6 md:flex-row">
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Pipeline</CardTitle>
          <CardDescription>Deals this quarter.</CardDescription>
        </CardHeader>
        <CardContent>
          <Progress value={64}>
            <ProgressLabel>Target reached</ProgressLabel>
            <ProgressValue />
          </Progress>
        </CardContent>
      </Card>
    </div>
    <aside
      aria-label="Acme renewal"
      className="flex min-w-0 shrink-0 flex-col gap-4 md:w-80"
    >
      <Card>
        <CardHeader>
          <CardTitle>Acme renewal</CardTitle>
          <CardDescription>
            <Badge variant="secondary">Negotiation</Badge>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="details">
            <TabsList>
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
            <TabsContent value="details">
              <dl className="grid grid-cols-2 gap-2 text-sm">
                {details.map((detail) => (
                  <div key={detail.label} className="contents">
                    <dt className="text-muted-foreground">{detail.label}</dt>
                    <dd>{detail.value}</dd>
                  </div>
                ))}
              </dl>
            </TabsContent>
            <TabsContent value="history">
              <ScrollArea className="h-40">
                <ol className="flex flex-col gap-2 text-sm">
                  {history.map((entry, index) => (
                    <li key={entry.id} className="flex flex-col gap-2">
                      {index > 0 ? <Separator /> : null}
                      <span className="text-muted-foreground">
                        {entry.when}
                      </span>
                      <span>{entry.what}</span>
                    </li>
                  ))}
                </ol>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </aside>
  </div>
);
