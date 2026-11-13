import { z } from "../zod.js";

// Mirrors ReportClientOption / ReportAuctionOption / BidOverviewReportRow / BidDetailsReportRow
// in services/client-reports.service.ts.

const istDateTime = z
  .string()
  .nullable()
  .openapi({ description: "IST wall-clock `YYYY-MM-DDTHH:MM:SS`.", example: "2026-10-21T11:00:00" });
const isoDate = z.string().nullable().openapi({ description: "`YYYY-MM-DD`." });

export const ClientReportClients = z
  .array(z.object({ clientId: z.number().int(), companyName: z.string() }))
  .openapi("ClientReportClients");

export const ClientReportAuctions = z
  .array(
    z.object({
      auctionId: z.number().int(),
      auctionNumber: z.string().nullable(),
      auctionDate: isoDate,
    }),
  )
  .openapi("ClientReportAuctions");

export const ClientReportBidOverviewRow = z
  .object({
    auctionNumber: z.string().nullable(),
    auctionDate: isoDate,
    lotNumber: z.string().nullable(),
    plantLocationName: z.string().nullable(),
    quantity: z.number().nullable(),
    unit: z.string().nullable().openapi({ description: "UOM code." }),
    startBidPrice: z.number().nullable(),
    startTime: istDateTime,
    endTime: istDateTime.openapi({ description: "Extended end time when the lot was extended." }),
    winningBidder: z.string().nullable(),
    winningPrice: z.number().nullable(),
    bidCount: z.number().int(),
    bidderCount: z.number().int(),
  })
  .openapi("ClientReportBidOverviewRow");

export const ClientReportBidOverview = z.array(ClientReportBidOverviewRow).openapi("ClientReportBidOverview");

export const ClientReportBidDetailsRow = z
  .object({
    auctionNumber: z.string().nullable(),
    auctionDate: isoDate,
    auctionType: z.string().nullable(),
    lotNumber: z.string().nullable(),
    startBidPrice: z.number().nullable(),
    startTime: istDateTime,
    endTime: istDateTime,
    bidderName: z.string().nullable(),
    bidTime: z
      .string()
      .nullable()
      .openapi({ description: "IST wall-clock with microseconds, `YYYY-MM-DDTHH:MM:SS.ffffff`." }),
    bidBasis: z.string().nullable(),
    bidPrice: z.number().nullable(),
    bidType: z.string().openapi({ description: "`Proxy` or `Manual`." }),
    quantity: z.number().nullable(),
  })
  .openapi("ClientReportBidDetailsRow");

export const ClientReportBidDetails = z.array(ClientReportBidDetailsRow).openapi("ClientReportBidDetails");
