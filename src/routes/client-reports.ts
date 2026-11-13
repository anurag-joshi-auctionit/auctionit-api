import { Router } from "express";
import { z } from "zod";
import { ClientReportsMessages } from "@auctionit/messages/reports";
import {
  requireAuth,
  requirePermission,
  requirePortalRole,
} from "../auth/middleware.js";
import { closedDateRangeQuerySchema } from "../lib/closed-auction-date-range.js";
import {
  buildBidDetailsReportFilename,
  buildBidDetailsReportXlsx,
  buildBidOverviewReportFilename,
  buildBidOverviewReportXlsx,
} from "../lib/client-reports/export-xlsx.js";
import {
  auctionReportTitle,
  dateRangeReportTitle,
} from "../lib/reports/report-title.js";
import { zodValidationErrorBody } from "../lib/validation-error.js";
import {
  ClientReportsAccessError,
  ClientReportsNotFoundError,
  clientReportsService,
} from "../services/client-reports.service.js";

const router = Router();
router.use(requireAuth);
router.use(requirePortalRole("client"));
router.use(requirePermission("module.portal-client-reports"));

/** Comma-separated positive ints, e.g. `1,2,3`. Empty / omitted → []. */
const optionalIdListSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (value == null) return [] as number[];
    const raw = Array.isArray(value) ? value.join(",") : value;
    if (!raw.trim()) return [] as number[];
    return [
      ...new Set(
        raw
          .split(",")
          .map((part) => Number(part.trim()))
          .filter((n) => Number.isInteger(n) && n > 0),
      ),
    ];
  });

const auctionsQuerySchema = closedDateRangeQuerySchema.and(
  z.object({
    clientIds: optionalIdListSchema,
  }),
);

const bidOverviewQuerySchema = closedDateRangeQuerySchema.and(
  z.object({
    clientIds: optionalIdListSchema,
    auctionIds: optionalIdListSchema,
    bidMode: z.enum(["bid", "no-bid"]).optional(),
  }),
);

const bidDetailsQuerySchema = z.object({
  clientId: z.coerce.number().int().positive({
    message: ClientReportsMessages.CLIENT_REQUIRED,
  }),
  auctionId: z.coerce.number().int().positive({
    message: ClientReportsMessages.AUCTION_REQUIRED,
  }),
});

function handleReportError(
  err: unknown,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  if (err instanceof ClientReportsAccessError) {
    res.status(403).json({ error: err.message });
    return;
  }
  if (err instanceof ClientReportsNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  next(err);
}

function sendXlsx(
  res: import("express").Response,
  buffer: Buffer,
  filename: string,
) {
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );
  res.setHeader("Cache-Control", "no-store");
  res.send(buffer);
}

router.get("/clients", async (req, res, next) => {
  try {
    res.json(await clientReportsService.listClients(req.user!.id));
  } catch (e) {
    next(e);
  }
});

router.get("/auctions", async (req, res, next) => {
  const parsed = auctionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        ClientReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!parsed.data.from || !parsed.data.to) {
    res.status(400).json({ error: ClientReportsMessages.DATE_RANGE_REQUIRED });
    return;
  }
  if (parsed.data.clientIds.length === 0) {
    res.status(400).json({ error: ClientReportsMessages.CLIENT_REQUIRED });
    return;
  }
  try {
    res.json(
      await clientReportsService.listAuctions(
        req.user!.id,
        parsed.data.clientIds,
        {
          from: parsed.data.from,
          to: parsed.data.to,
        },
      ),
    );
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/bid-overview", async (req, res, next) => {
  const parsed = bidOverviewQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        ClientReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!parsed.data.from || !parsed.data.to) {
    res.status(400).json({ error: ClientReportsMessages.DATE_RANGE_REQUIRED });
    return;
  }
  try {
    res.json(
      await clientReportsService.bidOverviewReport(req.user!.id, {
        from: parsed.data.from,
        to: parsed.data.to,
        clientIds: parsed.data.clientIds,
        auctionIds: parsed.data.auctionIds,
        bidMode: parsed.data.bidMode,
      }),
    );
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/bid-overview/export", async (req, res, next) => {
  const parsed = bidOverviewQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        ClientReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!parsed.data.from || !parsed.data.to) {
    res.status(400).json({ error: ClientReportsMessages.DATE_RANGE_REQUIRED });
    return;
  }
  try {
    const rows = await clientReportsService.bidOverviewReport(req.user!.id, {
      from: parsed.data.from,
      to: parsed.data.to,
      clientIds: parsed.data.clientIds,
      auctionIds: parsed.data.auctionIds,
      bidMode: parsed.data.bidMode,
    });
    const buffer = await buildBidOverviewReportXlsx(
      rows,
      dateRangeReportTitle(
        "Bid Overview Report",
        parsed.data.from,
        parsed.data.to,
      ),
    );
    sendXlsx(res, buffer, buildBidOverviewReportFilename());
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/bid-details", async (req, res, next) => {
  const parsed = bidDetailsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        ClientReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  try {
    res.json(
      await clientReportsService.bidDetailsReport(
        req.user!.id,
        parsed.data.clientId,
        parsed.data.auctionId,
      ),
    );
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/bid-details/export", async (req, res, next) => {
  const parsed = bidDetailsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        ClientReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  try {
    const rows = await clientReportsService.bidDetailsReport(
      req.user!.id,
      parsed.data.clientId,
      parsed.data.auctionId,
    );
    const meta = await clientReportsService.auctionReportMeta(
      req.user!.id,
      parsed.data.clientId,
      parsed.data.auctionId,
    );
    const buffer = await buildBidDetailsReportXlsx(
      rows,
      auctionReportTitle("Bid Details Report", meta, { includeClient: false }),
    );
    sendXlsx(res, buffer, buildBidDetailsReportFilename());
  } catch (e) {
    handleReportError(e, res, next);
  }
});

export default router;
