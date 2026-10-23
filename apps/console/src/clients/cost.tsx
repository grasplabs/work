/** A client's cost this month, as the grid and a rollout's page show it. */
import type { MonthCost } from "./grid.ts";

export const usd = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
});

/** A cost: all of it, with its AI Gateway share under it; unknown when null. */
export const Cost = ({ cost }: { cost: MonthCost | null }) =>
  cost === null ? (
    <span className="text-muted-foreground">unknown</span>
  ) : (
    <div className="flex flex-col">
      <span>{usd.format(cost.workers + cost.ai)}</span>
      <span className="text-muted-foreground text-xs">
        {`AI ${usd.format(cost.ai)}`}
      </span>
    </div>
  );
