import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/app-kit/components/card";
import { Grid } from "@grasp-os/app-kit/components/grid";
import { Stat } from "@grasp-os/app-kit/components/stat";
import { useQuery } from "@grasp-os/sdk/react";
import { api } from "@server/_generated/api";

import { stages } from "./stages";

export const Pipeline = () => {
  const pipeline = useQuery(api.deals.pipeline);
  const count = (stage: keyof typeof stages) =>
    pipeline?.find((group) => group.stage === stage)?.deals ?? 0;
  return (
    <Grid columns={4}>
      {(["lead", "qualified", "proposal", "won"] as const).map((stage) => (
        <Card key={stage} size="sm">
          <CardHeader>
            <CardTitle>{stages[stage]}</CardTitle>
          </CardHeader>
          <CardContent>
            <Stat variant={stage === "won" ? "done" : "default"}>
              {pipeline === undefined ? "–" : count(stage)}
            </Stat>
          </CardContent>
        </Card>
      ))}
    </Grid>
  );
};
