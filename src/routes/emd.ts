import { Router } from "express";
import { BiddersErrorMessages } from "@auctionit/messages/bidders";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../auth/middleware.js";
import {
  failEmd,
  parseEmdInput,
  parseEmdParam,
} from "../lib/emd/route-helpers.js";
import {
  emdAuctionIdParamSchema,
  emdBidderIdParamSchema,
  emdBidderReportFilterSchema,
  emdBidderReportQuerySchema,
  emdReleaseHistoryQuerySchema,
  emdCreditSchema,
  emdDepositsQuerySchema,
  emdDepositsSummaryQuerySchema,
  emdDepositUpdateSchema,
  emdTransactionIdParamSchema,
  emdPageQuerySchema,
  emdPassbookExportSchema,
  emdPassbookQuerySchema,
  emdRefundDecisionSchema,
  emdRefundIdParamSchema,
  emdRefundListQuerySchema,
  emdRefundPaySchema,
  emdSettlementJobsQuerySchema,
  emdSettlementResumeSchema,
  emdSettlementJobIdParamSchema,
  emdRefundSummaryQuerySchema,
  emdForfeitureAuctionOptionsQuerySchema,
  emdForfeitureCandidateAuctionsQuerySchema,
  emdForfeitureCandidatesQuerySchema,
  emdForfeitureListQuerySchema,
  emdForfeiturePayClientSchema,
  emdTransferListQuerySchema,
  emdTransferRequestSchema,
  emdTransferReviewSchema,
  emdTransferSummaryQuerySchema,
  emdReleaseLotsSchema,
  emdForfeitureRequestSchema,
  emdForfeitureReviewSchema,
  emdForfeitureSummaryQuerySchema,
} from "../lib/emd/schemas.js";
import { bidderBankAccountsService } from "../services/bidder-bank-accounts.service.js";
import { BidderNotFoundError } from "../services/bidders.service.js";
import { emdBlocksService } from "../services/emd-blocks.service.js";
import { emdCreditsService } from "../services/emd-credits.service.js";
import { emdForfeituresService } from "../services/emd-forfeitures.service.js";
import { emdTransfersService } from "../services/emd-transfers.service.js";
import { emdRefundsService } from "../services/emd-refunds.service.js";
import { emdReleaseService } from "../services/emd-release.service.js";
import { emdReportsService } from "../services/emd-reports.service.js";
import { emdSettlementService } from "../services/emd-settlement.service.js";
import { emdTransactionsService } from "../services/emd-transactions.service.js";
import { emdForfeitureDispositionsMasterService } from "../services/masters/emd-forfeiture-dispositions.service.js";
import { paymentTypesMasterService } from "../services/masters/payment-types.service.js";

const router = Router();
router.use(requireAuth);

const READ_LEDGER = [
  "emd.transactions.read",
  "emd.credits.write",
  "emd.blocks.release",
];
const READ_REFUNDS = [
  "emd.refunds.read",
  "emd.refunds.review",
  "emd.refunds.verify",
  "emd.refunds.pay",
];
const READ_TRANSFERS = [
  "emd.transfers.read",
  "emd.transfers.propose",
  "emd.transfers.review",
];

const READ_FORFEITURES = [
  "emd.forfeitures.read",
  "emd.forfeitures.propose",
  "emd.forfeitures.review",
  "emd.forfeitures.pay",
];

// ---- Ledger ----

router.get(
  "/bidders/options",
  requireAnyPermission(READ_LEDGER),
  async (_req, res, next) => {
    try {
      const [bidders, modes] = await Promise.all([
        emdTransactionsService.bidderOptions(),
        paymentTypesMasterService.list(true),
      ]);
      res.json({
        bidders,
        paymentModes: modes.map((m) => ({ id: m.id, label: m.name })),
      });
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

/** One bidder's passbook. */
router.get(
  "/transactions",
  requireAnyPermission([...READ_LEDGER, ...READ_REFUNDS, "emd.reports.read"]),
  async (req, res, next) => {
    const q = parseEmdInput(emdPassbookQuerySchema, req.query, res);
    if (!q) return;
    try {
      res.json(await emdTransactionsService.list({ ...q, hideCorrectedBlocks: true }));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

/** Export one bidder's passbook as XLSX. */
router.get(
  "/transactions/export",
  requireAnyPermission([...READ_LEDGER, ...READ_REFUNDS, "emd.reports.read"]),
  async (req, res, next) => {
    const q = parseEmdInput(emdPassbookExportSchema, req.query, res);
    if (!q) return;
    try {
      const buffer = await emdTransactionsService.passbookXlsx(q.bidderId);
      const date = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="emd-passbook-${q.bidderId}-${date}.xlsx"`);
      res.send(buffer);
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.post(
  "/credits",
  requirePermission("emd.credits.write"),
  async (req, res, next) => {
    const body = parseEmdInput(emdCreditSchema, req.body, res);
    if (!body) return;
    try {
      res
        .status(201)
        .json(await emdCreditsService.post({ ...body, userId: req.user!.id }));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.get(
  "/credits",
  requireAnyPermission(READ_LEDGER),
  async (req, res, next) => {
    const q = parseEmdInput(emdDepositsQuerySchema, req.query, res);
    if (!q) return;
    try {
      res.json(await emdCreditsService.list(q));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.get(
  "/credits/summary",
  requireAnyPermission(READ_LEDGER),
  async (req, res, next) => {
    const q = parseEmdInput(emdDepositsSummaryQuerySchema, req.query, res);
    if (!q) return;
    try {
      res.json(await emdCreditsService.summary(q));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.put(
  "/credits/:id",
  requirePermission("emd.credits.write"),
  async (req, res, next) => {
    const id = parseEmdParam(emdTransactionIdParamSchema, req.params.id, res);
    if (id == null) return;
    const body = parseEmdInput(emdDepositUpdateSchema, req.body, res);
    if (!body) return;
    try {
      res.json(await emdCreditsService.update(id, { ...body, userId: req.user!.id }));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

// ---- Per bidder ----

router.get(
  "/bidders/:bidderId/summary",
  requireAnyPermission([...READ_LEDGER, ...READ_REFUNDS]),
  async (req, res, next) => {
    const bidderId = parseEmdParam(
      emdBidderIdParamSchema,
      req.params.bidderId,
      res,
    );
    if (bidderId == null) return;
    try {
      res.json(await emdBlocksService.summary(bidderId));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.get(
  "/bidders/:bidderId/blocked",
  requireAnyPermission([...READ_LEDGER, ...READ_REFUNDS, "emd.reports.read"]),
  async (req, res, next) => {
    const bidderId = parseEmdParam(
      emdBidderIdParamSchema,
      req.params.bidderId,
      res,
    );
    if (bidderId == null) return;
    const q = parseEmdInput(emdPageQuerySchema, req.query, res);
    if (!q) return;
    try {
      res.json(await emdBlocksService.blocked(bidderId, q));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

/** The bidder's current bank account (refunds are paid to it), for refund reviewers. */
router.get(
  "/bidders/:bidderId/bank-account",
  requireAnyPermission(READ_REFUNDS),
  async (req, res, next) => {
    const bidderId = parseEmdParam(
      emdBidderIdParamSchema,
      req.params.bidderId,
      res,
    );
    if (bidderId == null) return;
    try {
      const bankAccount = await bidderBankAccountsService.getByBidderId(bidderId);
      res.json({ bankAccount });
    } catch (e) {
      if (e instanceof BidderNotFoundError) {
        res.status(404).json({ error: BiddersErrorMessages.BIDDER_NOT_FOUND });
        return;
      }
      failEmd(e, res, next);
    }
  },
);

// ---- Blocks ----

// ---- Release (Winning EMD pending lifting) ----

router.get(
  "/release/bidders",
  requirePermission("emd.blocks.release"),
  async (req, res, next) => {
    const q = parseEmdInput(emdBidderReportQuerySchema, req.query, res);
    if (!q) return;
    try {
      res.json(await emdReleaseService.bidders(q));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.get(
  "/release/bidders/summary",
  requirePermission("emd.blocks.release"),
  async (req, res, next) => {
    const q = parseEmdInput(emdBidderReportFilterSchema, req.query, res);
    if (!q) return;
    try {
      res.json(await emdReleaseService.summary(q));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.get(
  "/release/bidders/:bidderId/lots",
  requirePermission("emd.blocks.release"),
  async (req, res, next) => {
    const bidderId = parseEmdParam(
      emdBidderIdParamSchema,
      req.params.bidderId,
      res,
    );
    if (bidderId == null) return;
    try {
      res.json(await emdReleaseService.pendingLots(bidderId));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.post(
  "/release/bidders/:bidderId/release",
  requirePermission("emd.blocks.release"),
  async (req, res, next) => {
    const bidderId = parseEmdParam(
      emdBidderIdParamSchema,
      req.params.bidderId,
      res,
    );
    if (bidderId == null) return;
    const body = parseEmdInput(emdReleaseLotsSchema, req.body, res);
    if (!body) return;
    try {
      res.json(
        await emdReleaseService.releaseLots({
          bidderId,
          lots: body.lots,
          userId: req.user!.id,
        }),
      );
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.get(
  "/release/history",
  requirePermission("emd.blocks.release"),
  async (req, res, next) => {
    const q = parseEmdInput(emdReleaseHistoryQuerySchema, req.query, res);
    if (!q) return;
    try {
      res.json(await emdReleaseService.history(q));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

// ---- Refunds ----

router.get(
  "/refunds/summary",
  requireAnyPermission(READ_REFUNDS),
  async (req, res, next) => {
    const q = parseEmdInput(emdRefundSummaryQuerySchema, req.query, res);
    if (!q) return;
    try {
      res.json(await emdRefundsService.summary(q));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.get(
  "/refunds",
  requireAnyPermission(READ_REFUNDS),
  async (req, res, next) => {
    const q = parseEmdInput(emdRefundListQuerySchema, req.query, res);
    if (!q) return;
    try {
      res.json(await emdRefundsService.list(q));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.post(
  "/refunds/:refundId/review",
  requirePermission("emd.refunds.review"),
  async (req, res, next) => {
    const refundId = parseEmdParam(
      emdRefundIdParamSchema,
      req.params.refundId,
      res,
    );
    if (refundId == null) return;
    const body = parseEmdInput(emdRefundDecisionSchema, req.body, res);
    if (!body) return;
    try {
      await emdRefundsService.review({
        refundId,
        ...body,
        userId: req.user!.id,
      });
      res.json({ ok: true });
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.post(
  "/refunds/:refundId/verify",
  requirePermission("emd.refunds.verify"),
  async (req, res, next) => {
    const refundId = parseEmdParam(
      emdRefundIdParamSchema,
      req.params.refundId,
      res,
    );
    if (refundId == null) return;
    const body = parseEmdInput(emdRefundDecisionSchema, req.body, res);
    if (!body) return;
    try {
      await emdRefundsService.verify({
        refundId,
        ...body,
        userId: req.user!.id,
      });
      res.json({ ok: true });
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.post(
  "/refunds/:refundId/pay",
  requirePermission("emd.refunds.pay"),
  async (req, res, next) => {
    const refundId = parseEmdParam(
      emdRefundIdParamSchema,
      req.params.refundId,
      res,
    );
    if (refundId == null) return;
    const body = parseEmdInput(emdRefundPaySchema, req.body, res);
    if (!body) return;
    try {
      await emdRefundsService.markPaid({
        refundId,
        ...body,
        userId: req.user!.id,
      });
      res.json({ ok: true });
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

// ---- Reports ----

router.get(
  "/reports/bidder-wise",
  requirePermission("emd.reports.read"),
  async (req, res, next) => {
    const q = parseEmdInput(emdBidderReportQuerySchema, req.query, res);
    if (!q) return;
    try {
      res.json(await emdReportsService.bidderWise(q));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.get(
  "/reports/bidder-wise/summary",
  requirePermission("emd.reports.read"),
  async (req, res, next) => {
    const q = parseEmdInput(emdBidderReportFilterSchema, req.query, res);
    if (!q) return;
    try {
      res.json(await emdReportsService.bidderWiseSummary(q));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.get(
  "/reports/bidder-wise/export",
  requirePermission("emd.reports.read"),
  async (req, res, next) => {
    const q = parseEmdInput(emdBidderReportFilterSchema, req.query, res);
    if (!q) return;
    try {
      const buffer = await emdReportsService.bidderWiseXlsx(q);
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="emd-report-${stamp}.xlsx"`,
      );
      res.send(buffer);
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

// ---- Settlement jobs ----

router.get(
  "/settlement-jobs",
  requireAnyPermission(READ_LEDGER),
  async (req, res, next) => {
    const q = parseEmdInput(emdSettlementJobsQuerySchema, req.query, res);
    if (!q) return;
    try {
      res.json(
        await emdSettlementService.list({
          statuses: q.status,
          auctionId: q.auctionId,
          page: q.page,
          pageSize: q.pageSize,
        }),
      );
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.post(
  "/settlement-jobs/resume",
  requirePermission("emd.blocks.release"),
  async (req, res, next) => {
    const body = parseEmdInput(emdSettlementResumeSchema, req.body ?? {}, res);
    if (!body) return;
    try {
      res.json({
        resumed: await emdSettlementService.resume(body.jobIds ?? null),
      });
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.post(
  "/settlement-jobs/:jobId/retry",
  requirePermission("emd.blocks.release"),
  async (req, res, next) => {
    const jobId = parseEmdParam(
      emdSettlementJobIdParamSchema,
      req.params.jobId,
      res,
    );
    if (jobId == null) return;
    try {
      await emdSettlementService.retry(jobId);
      res.json({ ok: true });
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

// ---- Forfeitures ----

router.get(
  "/forfeitures/summary",
  requireAnyPermission(READ_FORFEITURES),
  async (req, res, next) => {
    const q = parseEmdInput(emdForfeitureSummaryQuerySchema, req.query, res);
    if (!q) return;
    try {
      res.json(await emdForfeituresService.summary(q));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.get(
  "/forfeitures/auction-options",
  requireAnyPermission(READ_FORFEITURES),
  async (req, res, next) => {
    const q = parseEmdInput(
      emdForfeitureAuctionOptionsQuerySchema,
      req.query,
      res,
    );
    if (!q) return;
    try {
      res.json(await emdForfeituresService.auctionOptions(q));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.get(
  "/forfeitures/dispositions",
  requirePermission("emd.forfeitures.propose"),
  async (_req, res, next) => {
    try {
      res.json(await emdForfeitureDispositionsMasterService.list(true));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.get(
  "/forfeitures/candidate-auctions",
  requirePermission("emd.forfeitures.propose"),
  async (req, res, next) => {
    const q = parseEmdInput(
      emdForfeitureCandidateAuctionsQuerySchema,
      req.query,
      res,
    );
    if (!q) return;
    try {
      res.json(await emdForfeituresService.candidateAuctions(q));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.get(
  "/forfeitures/candidates",
  requirePermission("emd.forfeitures.propose"),
  async (req, res, next) => {
    const q = parseEmdInput(emdForfeitureCandidatesQuerySchema, req.query, res);
    if (!q) return;
    try {
      res.json(await emdForfeituresService.candidates(q));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.get(
  "/forfeitures",
  requireAnyPermission(READ_FORFEITURES),
  async (req, res, next) => {
    const q = parseEmdInput(emdForfeitureListQuerySchema, req.query, res);
    if (!q) return;
    try {
      res.json(await emdForfeituresService.list(q));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.post(
  "/forfeitures",
  requirePermission("emd.forfeitures.propose"),
  async (req, res, next) => {
    const body = parseEmdInput(emdForfeitureRequestSchema, req.body, res);
    if (!body) return;
    try {
      res
        .status(201)
        .json(
          await emdForfeituresService.request({
            ...body,
            userId: req.user!.id,
          }),
        );
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.post(
  "/forfeitures/review",
  requirePermission("emd.forfeitures.review"),
  async (req, res, next) => {
    const body = parseEmdInput(emdForfeitureReviewSchema, req.body, res);
    if (!body) return;
    try {
      res.json(
        await emdForfeituresService.review({ ...body, userId: req.user!.id }),
      );
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.post(
  "/forfeitures/pay-client",
  requirePermission("emd.forfeitures.pay"),
  async (req, res, next) => {
    const body = parseEmdInput(emdForfeiturePayClientSchema, req.body, res);
    if (!body) return;
    try {
      res.json(
        await emdForfeituresService.payClient({
          ...body,
          userId: req.user!.id,
        }),
      );
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

// ---- Transfers ----

router.get(
  "/transfers/summary",
  requireAnyPermission(READ_TRANSFERS),
  async (req, res, next) => {
    const q = parseEmdInput(emdTransferSummaryQuerySchema, req.query, res);
    if (!q) return;
    try {
      res.json(await emdTransfersService.summary(q));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.get("/transfers", requireAnyPermission(READ_TRANSFERS), async (req, res, next) => {
  const q = parseEmdInput(emdTransferListQuerySchema, req.query, res);
  if (!q) return;
  try {
    res.json(await emdTransfersService.list(q));
  } catch (e) {
    failEmd(e, res, next);
  }
});

router.post(
  "/transfers",
  requirePermission("emd.transfers.propose"),
  async (req, res, next) => {
    const body = parseEmdInput(emdTransferRequestSchema, req.body, res);
    if (!body) return;
    try {
      res.status(201).json(await emdTransfersService.request({ ...body, userId: req.user!.id }));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

router.post(
  "/transfers/review",
  requirePermission("emd.transfers.review"),
  async (req, res, next) => {
    const body = parseEmdInput(emdTransferReviewSchema, req.body, res);
    if (!body) return;
    try {
      res.json(await emdTransfersService.review({ ...body, userId: req.user!.id }));
    } catch (e) {
      failEmd(e, res, next);
    }
  },
);

export default router;
