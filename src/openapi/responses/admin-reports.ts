import { paginated } from "../common.js";
import { z } from "../zod.js";

// Mirrors the report types in services/admin-reports.service.ts, sealed-bid-report.service.ts,
// subscription-report.service.ts, benchmark-report.service.ts, market-report.service.ts,
// revenue-report.service.ts, lifting-report.service.ts and report-exports.service.ts.

const isoDate = z.string().nullable().openapi({ description: "`YYYY-MM-DD`." });
const istDateTime = z
  .string()
  .nullable()
  .openapi({ description: "IST wall-clock `YYYY-MM-DDTHH:MM:SS`.", example: "2026-10-21T11:00:00" });
const istBidTime = z
  .string()
  .nullable()
  .openapi({ description: "IST wall-clock with microseconds, `YYYY-MM-DDTHH:MM:SS.ffffff`." });
const bidType = z.string().openapi({ description: "`Proxy` or `Manual`." });

export const AdminReportAuctionOptions = z
  .array(
    z.object({
      auctionId: z.number().int(),
      auctionNumber: z.string().nullable(),
      auctionDate: isoDate,
    }),
  )
  .openapi("AdminReportAuctionOptions");

export const AdminReportBidOverview = z
  .array(
    z
      .object({
        auctionNumber: z.string().nullable(),
        auctionDate: isoDate,
        lotNumber: z.string().nullable(),
        plantLocationName: z.string().nullable(),
        quantity: z.number().nullable(),
        unit: z.string().nullable(),
        startBidPrice: z.number().nullable(),
        startTime: istDateTime,
        endTime: istDateTime,
        winningBidder: z.string().nullable(),
        winningPrice: z.number().nullable(),
        bidCount: z.number().int(),
        bidderCount: z.number().int(),
      })
      .openapi("AdminReportBidOverviewRow"),
  )
  .openapi("AdminReportBidOverview");

export const AdminReportBidDetails = z
  .array(
    z
      .object({
        auctionNumber: z.string().nullable(),
        auctionDate: isoDate,
        auctionType: z.string().nullable(),
        lotNumber: z.string().nullable(),
        startBidPrice: z.number().nullable(),
        startTime: istDateTime,
        endTime: istDateTime,
        bidderName: z.string().nullable(),
        username: z.string().nullable(),
        bidTime: istBidTime,
        bidBasis: z.string().nullable(),
        bidPrice: z.number().nullable(),
        bidType,
        quantity: z.number().nullable(),
      })
      .openapi("AdminReportBidDetailsRow"),
  )
  .openapi("AdminReportBidDetails");

export const AdminReportBidderDetails = z
  .array(
    z
      .object({
        clientName: z.string().nullable(),
        auctionNumber: z.string().nullable(),
        auctionDate: isoDate,
        bidderName: z.string().nullable(),
        username: z.string().nullable(),
        bidderId: z.number().int(),
        companyName: z.string().nullable(),
        phone: z.string().nullable(),
        email: z.string().nullable(),
        lastLoginAt: istDateTime,
        lastLogoutAt: istDateTime,
        placedBid: z.boolean().openapi({ description: "Placed at least one bid in this auction." }),
        isNew: z.boolean().openapi({ description: "Never bid in another auction of this client." }),
        tncAcceptedAt: istDateTime,
      })
      .openapi("AdminReportBidderDetailsRow"),
  )
  .openapi({ description: "Bidders attached to the auction, sorted by company name." })
  .openapi("AdminReportBidderDetails");

export const AdminReportBidderOverview = z
  .array(
    z
      .object({
        clientName: z.string().nullable(),
        auctionNumber: z.string().nullable(),
        auctionDate: isoDate,
        attached: z.number().int(),
        loggedIn: z.number().int(),
        participated: z.number().int(),
        winners: z.number().int(),
        newAttached: z.number().int(),
        newParticipated: z.number().int(),
        newWinners: z.number().int(),
      })
      .openapi("AdminReportBidderOverviewRow"),
  )
  .openapi("AdminReportBidderOverview");

export const AdminReportAuctionOverview = z
  .array(
    z
      .object({
        clientName: z.string().nullable(),
        auctionNumber: z.string().nullable(),
        auctionDate: isoDate,
        lotNumber: z.string().nullable(),
        startTime: istDateTime,
        endTime: istDateTime,
        quantity: z.number().nullable(),
        unit: z.string().nullable(),
        startBidPrice: z.number().nullable(),
        bidIncrement: z.number().nullable(),
        winningPrice: z.number().nullable(),
        winningBidder: z.string().nullable(),
        bidCount: z.number().int(),
        bidderCount: z.number().int(),
      })
      .openapi("AdminReportAuctionOverviewRow"),
  )
  .openapi("AdminReportAuctionOverview");

export const AdminReportAuctionDetails = z
  .object({
    meta: z.object({
      clientName: z.string().nullable(),
      auctionNumber: z.string().nullable(),
      auctionDate: isoDate,
    }),
    additionalFields: z
      .array(
        z.object({
          key: z.string(),
          fieldId: z.number().int(),
          label: z.string(),
          scope: z.enum(["auction", "lot"]),
          dataType: z.enum(["text", "number", "date", "boolean"]),
        }),
      )
      .openapi({
        description:
          "Dynamic summary columns for the client additional fields selected on the auction (auction-scope first, then lot-scope).",
      }),
    summary: z.array(
      z.object({
        lotId: z.number().int(),
        lotNumber: z.string().nullable(),
        startTime: istDateTime,
        endTime: istDateTime,
        clientName: z.string().nullable(),
        plantLocationName: z.string().nullable(),
        product: z.string().nullable(),
        quantity: z.number().nullable(),
        unit: z.string().nullable(),
        startBidPrice: z.number().nullable(),
        bidIncrement: z.number().nullable(),
        winningPrice: z.number().nullable(),
        winningBidder: z.string().nullable(),
        bidCount: z.number().int(),
        bidderCount: z.number().int(),
        additionalValues: z.record(z.string()).openapi({
          description: "Display values keyed by `additionalFields[].key` (dates as DD-MM-YYYY); auction-level values repeat on every lot.",
        }),
      }),
    ),
    bids: z.array(
      z.object({
        lotId: z.number().int(),
        lotNumber: z.string().nullable(),
        product: z.string().nullable(),
        quantity: z.number().nullable(),
        unit: z.string().nullable(),
        clientName: z.string().nullable(),
        bidTime: istBidTime,
        bidderName: z.string().nullable(),
        bidAmount: z.number().nullable(),
        bidType,
      }),
    ),
    participants: z.array(
      z.object({
        companyName: z.string().nullable(),
        city: z.string().nullable(),
        emdBalance: z.number().nullable(),
      }),
    ),
  })
  .openapi("AdminReportAuctionDetails");

export const AdminReportSealedBids = z
  .array(
    z
      .object({
        lotId: z.number().int(),
        clientId: z.number().int(),
        clientName: z.string().nullable(),
        auctionNumber: z.string().nullable(),
        auctionDate: isoDate,
        lotNumber: z.string().nullable(),
        uom: z.string().nullable(),
        sealedBidDate: isoDate,
        startTime: istDateTime,
        endTime: istDateTime,
        minAmount: z.number().nullable(),
        maxAmount: z.number().nullable(),
        avgAmount: z.number().nullable(),
        bidderCount: z.number().int(),
        winningBidder: z.string().nullable(),
        winningAmount: z.number().nullable(),
      })
      .openapi("AdminReportSealedBidRow"),
  )
  .openapi("AdminReportSealedBids");

export const AdminReportSubscriptionRow = z
  .object({
    subscriptionId: z.number().int(),
    bidderId: z.number().int(),
    bidderName: z.string().nullable(),
    bidderAddress: z.string().nullable().openapi({ description: "Address, city, state and pincode joined." }),
    email: z.string().nullable(),
    mobile: z.string().nullable(),
    subscriptionTypeName: z.string().nullable(),
    paymentDate: isoDate,
    paymentModeName: z.string().nullable(),
    transactionId: z.string().nullable(),
    amount: z.number(),
    fromDate: isoDate,
    toDate: isoDate,
  })
  .openapi("AdminReportSubscriptionRow");

export const AdminReportSubscriptionPage = paginated(AdminReportSubscriptionRow, {
  totalAmount: z.number().openapi({ description: "Sum of `amount` over every row in range (all pages)." }),
  subscriberCount: z.number().int().openapi({ description: "Distinct bidders in range (all pages)." }),
}).openapi("AdminReportSubscriptionPage");

export const AdminReportBenchmarkMaterials = z
  .array(z.string())
  .openapi({ description: "Active benchmark material names." })
  .openapi("AdminReportBenchmarkMaterials");

const currency = z.enum(["INR", "USD"]);

export const AdminReportBenchmark = z
  .object({
    material: z.string(),
    series: z.array(
      z.object({
        comboId: z.number().int(),
        location: z.string(),
        currency: currency.openapi({ description: "Currency prices were entered in; report values are always INR." }),
        label: z.string().openapi({ description: "Location, suffixed with ` (INR)` when converted from another currency." }),
      }),
    ),
    rows: z
      .array(
        z.object({
          date: z.string().openapi({ description: "`YYYY-MM-DD`." }),
          prices: z.record(z.number()).openapi({
            description: "INR price keyed by `comboId`; a missing key means no price was entered for that date.",
          }),
        }),
      )
      .openapi({ description: "Newest date first; only dates with at least one price." }),
  })
  .openapi("AdminReportBenchmark");

export const AdminReportMarketBenchmarkOptions = z
  .array(z.object({ id: z.number().int(), material: z.string(), location: z.string() }))
  .openapi("AdminReportMarketBenchmarkOptions");

const revenueTotals = {
  auctionedValuePeriod: z.number(),
  approvedValuePeriod: z.number(),
  liftedValuePeriod: z.number(),
  auctionedValueItd: z.number().openapi({ description: "Inception to date (up to `to`)." }),
  approvedValueItd: z.number(),
  liftedValueItd: z.number(),
  totalRevenue: z.number().openapi({
    description: "Service fee estimate from the client's fee config applied to lifting dated within the period.",
  }),
};

export const AdminReportRevenueSummaryPage = paginated(
  z
    .object({ clientId: z.number().int(), clientName: z.string(), ...revenueTotals })
    .openapi("AdminReportRevenueSummaryRow"),
  {
    totals: z
      .object(revenueTotals)
      .openapi({ description: "Sums over every client in range, not just this page." }),
  },
).openapi("AdminReportRevenueSummaryPage");

export const AdminReportLiftingOverviewPage = paginated(
  z
    .object({
      lotId: z.number().int(),
      clientName: z.string(),
      auctionNumber: z.string().nullable(),
      auctionDate: isoDate,
      lotNumber: z.string().nullable(),
      winningBidder: z.string().nullable(),
      winningPrice: z.number().nullable(),
      unit: z.string().nullable(),
      approvedQty: z.number(),
      liftedBeforePeriodQty: z.number(),
      liftedBeforePeriodValue: z.number().nullable(),
      liftedPeriodQty: z.number(),
      liftedPeriodValue: z.number().nullable(),
      balanceQty: z.number().openapi({ description: "Approved minus everything lifted up to `to`." }),
      lastLiftedDate: isoDate,
      status: z.string().nullable(),
    })
    .openapi("AdminReportLiftingOverviewRow"),
  {
    stats: z
      .object({
        approvedQty: z.number(),
        liftedPeriodQty: z.number(),
        balanceQty: z.number(),
        liftedPeriodValue: z.number(),
      })
      .openapi({ description: "Over every lot in range, not just this page." }),
  },
).openapi("AdminReportLiftingOverviewPage");

export const AdminReportExportJob = z
  .object({ jobId: z.string().uuid() })
  .openapi("AdminReportExportJob");
