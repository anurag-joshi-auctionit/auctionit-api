import { z } from "../zod.js";

// Mirrors the *Dashboard types in services/admin-dashboard/*.service.ts.

const period = z.string().openapi({
  description:
    "Bucket start, `YYYY-MM-DD`. Buckets are months for ranges up to 18 months, quarters up to 36 months, else years.",
  example: "2026-04-01",
});
const periodLabel = z.string().openapi({ description: "Display label for the bucket.", example: "Apr 2026" });
const currentPeriodLabel = z
  .string()
  .openapi({ description: "Selected range as `DD MMM YYYY – DD MMM YYYY`.", example: "01 Apr 2026 – 30 Sep 2026" });

export const AdminDashboardAuctions = z
  .object({
    stats: z.object({
      auctionsConducted: z.number().int(),
      auctionedValue: z.number(),
      liftedValue: z.number(),
      avgBiddersPerLot: z.number(),
      totalRevenue: z.number().openapi({ description: "Subscription amounts + service invoice amounts in range." }),
    }),
    series: z.array(
      z.object({
        period,
        periodLabel,
        auctions: z.number().int(),
        auctionedValue: z.number(),
        liftedValue: z.number(),
      }),
    ),
    currentPeriodLabel,
  })
  .openapi("AdminDashboardAuctions");

export const AdminDashboardClients = z
  .object({
    stats: z.object({
      newClients: z.number().int(),
      activeClients: z.number().int(),
      clientsWithAuctions: z.number().int(),
      dormant: z.number().int(),
    }),
    rows: z
      .array(
        z.object({
          clientId: z.number().int(),
          clientName: z.string(),
          auctionCount: z.number().int(),
          lotsOffered: z.number().int(),
          lotsSold: z.number().int(),
          saleValue: z.number(),
        }),
      )
      .openapi({ description: "Top 5 clients by sale value in range." }),
    currentPeriodLabel,
  })
  .openapi("AdminDashboardClients");

export const AdminDashboardBidders = z
  .object({
    stats: z.object({
      newBidders: z.number().int(),
      pendingVerification: z.number().int(),
      bankUpdatesPending: z.number().int(),
      participatingBidders: z.number().int(),
    }),
    series: z.array(z.object({ period, periodLabel, count: z.number().int() })),
    rows: z
      .array(
        z.object({
          bidderId: z.number().int(),
          companyName: z.string(),
          lotsWon: z.number().int(),
          winValue: z.number(),
        }),
      )
      .openapi({ description: "Top 5 bidders by win value (then lots won) in range." }),
    currentPeriodLabel,
  })
  .openapi("AdminDashboardBidders");

export const AdminDashboardMaterials = z
  .object({
    rows: z
      .array(
        z.object({
          materialId: z.number().int(),
          label: z.string(),
          quantity: z.number(),
        }),
      )
      .openapi({ description: "Top 5 materials by quantity on won lots of auctions in range." }),
  })
  .openapi("AdminDashboardMaterials");

export const AdminDashboardLifting = z
  .object({
    stats: z.object({
      auctionedValue: z.number(),
      bidValue: z.number(),
      approvedValue: z.number(),
      liftedValue: z.number(),
    }),
    series: z.array(
      z.object({
        period,
        periodLabel,
        auctionedValue: z.number(),
        bidValue: z.number(),
        approvedValue: z.number(),
        liftedValue: z.number(),
      }),
    ),
    currentPeriodLabel,
  })
  .openapi("AdminDashboardLifting");

export const AdminDashboardServiceInvoices = z
  .object({
    stats: z.object({
      generatedInRange: z.number().int(),
      invoicedValue: z.number(),
      collectedInRange: z.number(),
      outstandingAsOnToday: z.number().openapi({ description: "Unpaid amount as of today, independent of the range." }),
    }),
    series: z.array(z.object({ period, periodLabel, invoiced: z.number(), collected: z.number() })),
    rows: z
      .array(
        z.object({
          clientId: z.number().int(),
          clientName: z.string(),
          unpaidAmount: z.number(),
        }),
      )
      .openapi({ description: "Top 5 clients by unpaid invoice amount." }),
    currentPeriodLabel,
  })
  .openapi("AdminDashboardServiceInvoices");

export const AdminDashboardSubscriptions = z
  .object({
    stats: z.object({
      newSubscriptions: z.number().int(),
      subscriptionAmount: z.number(),
      activeToday: z.number().int(),
      expiringIn30Days: z.number().int(),
    }),
    series: z.array(
      z.object({ period, periodLabel, count: z.number().int(), subscriptionAmount: z.number() }),
    ),
    currentPeriodLabel,
  })
  .openapi("AdminDashboardSubscriptions");
