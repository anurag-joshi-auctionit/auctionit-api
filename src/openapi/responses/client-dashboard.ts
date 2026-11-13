import { z } from "../zod.js";

// Mirrors the types in services/client-dashboard.service.ts and MetricWithDelta in lib/dashboard/period.ts.

const MetricWithDelta = z
  .object({
    value: z.number(),
    previousValue: z.number().openapi({ description: "Same metric for the equal-length period just before `from`." }),
    percentChange: z.number().openapi({
      description: "`(value - previous) / |previous| * 100`; 0 when both are 0, ±100 when previous is 0.",
    }),
    previousPeriodLabel: z.string(),
  })
  .openapi("ClientDashboardMetric");

const periodLabels = {
  currentPeriodLabel: z.string().openapi({ example: "01 Apr 2026 – 30 Sep 2026" }),
  previousPeriodLabel: z.string().openapi({ example: "01 Oct 2025 – 31 Mar 2026" }),
};

export const ClientDashboardClients = z
  .array(z.object({ clientId: z.number().int(), companyName: z.string() }))
  .openapi("ClientDashboardClients");

export const ClientDashboardAuctions = z
  .array(
    z.object({
      auctionId: z.number().int(),
      auctionNumber: z.string().nullable(),
      auctionDate: z.string().nullable().openapi({ description: "`YYYY-MM-DD`." }),
    }),
  )
  .openapi("ClientDashboardAuctions");

export const ClientDashboardSummary = z
  .object({
    totalAuctions: MetricWithDelta,
    totalBidQtyMt: MetricWithDelta,
    totalBidValueCr: MetricWithDelta.openapi({ description: "In crore." }),
    attachedBidders: MetricWithDelta,
    participatedBidders: MetricWithDelta,
    newBidders: MetricWithDelta,
    auctionsBidderLt5: MetricWithDelta,
    auctionsBidder5To10: MetricWithDelta,
    auctionsBidderGt10: MetricWithDelta,
    totalApprovedQtyMt: MetricWithDelta,
    totalLiftedQtyMt: MetricWithDelta,
    delayReasons: z.array(z.object({ reason: z.string(), lotCount: z.number().int() })),
    ...periodLabels,
  })
  .openapi("ClientDashboardSummary");

const idName = z.object({ id: z.number().int(), name: z.string() });

export const ClientDashboardMaterialFilters = z
  .object({ plants: z.array(idName), items: z.array(idName) })
  .openapi("ClientDashboardMaterialFilters");

export const ClientDashboardMaterialSeries = z
  .object({
    grain: z.enum(["month", "quarter", "year"]).openapi({
      description: "Month for ranges up to 18 months, quarter up to 36 months, else year.",
    }),
    points: z.array(
      z.object({
        period: z.string().openapi({ description: "Bucket start, `YYYY-MM-DD`." }),
        periodLabel: z.string(),
        offeredQty: z.number(),
        bidQty: z.number(),
        approvedQty: z.number(),
        offeredAmountLakh: z.number(),
        bidAmountLakh: z.number(),
        approvedAmountLakh: z.number(),
      }),
    ),
  })
  .openapi("ClientDashboardMaterialSeries");

const liftingTotals = {
  materialApprovedMt: z.number(),
  materialLiftedMt: z.number(),
  materialPendingMt: z.number(),
  breakUp0To5: z.number().openapi({ description: "MT lifted 0–5 days after the auction date." }),
  breakUp6To10: z.number().openapi({ description: "MT lifted 6–10 days after the auction date." }),
  breakUpBeyond10: z.number().openapi({ description: "MT lifted more than 10 days after the auction date." }),
};

export const ClientDashboardLifting = z
  .object({
    summary: z.object(liftingTotals),
    rows: z.array(
      z.object({
        auctionId: z.number().int(),
        auctionNumber: z.string().nullable(),
        auctionDate: z.string().nullable(),
        ...liftingTotals,
      }),
    ),
  })
  .openapi("ClientDashboardLifting");

export const ClientDashboardBidder = z
  .object({
    attachedBidders: MetricWithDelta,
    participatedBidders: MetricWithDelta,
    newBidders: MetricWithDelta,
    ...periodLabels,
  })
  .openapi("ClientDashboardBidder");
