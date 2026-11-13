import { z } from "../zod.js";

// Mirrors BidderDashboardClientOption / BidderLiftingFilters / BidderLiftingDetails
// in services/bidder-dashboard.service.ts.

export const BidderDashboardClients = z
  .array(
    z.object({
      clientId: z.number().int(),
      companyName: z.string().openapi({ description: "Falls back to `Client #<id>` when the client has no name." }),
    }),
  )
  .openapi("BidderDashboardClients");

const idName = z.object({ id: z.number().int(), name: z.string() });

export const BidderDashboardLiftingFilters = z
  .object({ plants: z.array(idName), items: z.array(idName) })
  .openapi("BidderDashboardLiftingFilters");

const liftingTotals = {
  materialApprovedMt: z.number(),
  materialLiftedMt: z.number(),
  materialPendingMt: z.number(),
  approvedValue: z.number(),
  liftedValue: z.number(),
};

export const BidderDashboardLifting = z
  .object({
    summary: z.object(liftingTotals),
    rows: z
      .array(z.object({ clientId: z.number().int(), clientName: z.string().nullable(), ...liftingTotals }))
      .openapi({ description: "One row per seller (client)." }),
    series: z.object({
      grain: z.enum(["month", "quarter", "year"]).openapi({
        description: "Month for ranges up to 18 months, quarter up to 36 months, else year.",
      }),
      points: z.array(
        z.object({
          period: z.string().openapi({ description: "Bucket start, `YYYY-MM-DD`." }),
          periodLabel: z.string(),
          approvedQty: z.number(),
          liftedQty: z.number(),
          approvedAmount: z.number(),
          liftedAmount: z.number(),
        }),
      ),
    }),
  })
  .openapi("BidderDashboardLifting");
