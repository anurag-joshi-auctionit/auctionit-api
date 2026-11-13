import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { AdminDashboardMessages } from "@auctionit/messages/admin-dashboard";
import {
  requireAuth,
  requirePermission,
  requireAnyPermission,
} from "../auth/middleware.js";
import { closedDateRangeQuerySchema } from "../lib/closed-auction-date-range.js";
import type { IsoDateRange } from "../lib/dashboard/period.js";
import { zodValidationErrorBody } from "../lib/validation-error.js";
import { getAuctions } from "../services/admin-dashboard/auctions.service.js";
import { getBidders } from "../services/admin-dashboard/bidders.service.js";
import { getClients } from "../services/admin-dashboard/clients.service.js";
import { getLifting } from "../services/admin-dashboard/lifting.service.js";
import { getMaterials } from "../services/admin-dashboard/materials.service.js";
import { getServiceInvoices } from "../services/admin-dashboard/service-invoices.service.js";
import { getSubscriptions } from "../services/admin-dashboard/subscriptions.service.js";

const router = Router();
router.use(requireAuth, requirePermission("module.dashboard"));

function requireDateRange(
  data: { from?: string; to?: string },
  res: Response,
): data is { from: string; to: string } {
  if (!data.from || !data.to) {
    res
      .status(400)
      .json({ error: AdminDashboardMessages.DATE_RANGE_REQUIRED });
    return false;
  }
  return true;
}

function rangeHandler(fn: (range: IsoDateRange) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const parsed = closedDateRangeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(
        zodValidationErrorBody(
          parsed.error,
          AdminDashboardMessages.VALIDATION_FAILED,
        ),
      );
      return;
    }
    if (!requireDateRange(parsed.data, res)) return;
    try {
      res.json(await fn({ from: parsed.data.from, to: parsed.data.to }));
    } catch (e) {
      next(e);
    }
  };
}

router.get(
  "/auctions",
  requireAnyPermission(["module.auctions", "auctions.read"]),
  rangeHandler(getAuctions),
);
router.get(
  "/clients",
  requireAnyPermission(["module.clients", "clients.read"]),
  rangeHandler(getClients),
);
router.get(
  "/bidders",
  requireAnyPermission(["module.bidders", "bidders.read"]),
  rangeHandler(getBidders),
);
router.get(
  "/materials",
  requireAnyPermission(["materials.read", "module.inventory"]),
  rangeHandler(getMaterials),
);
router.get(
  "/lifting",
  requireAnyPermission(["module.lifting", "lifting.clients.read"]),
  rangeHandler(getLifting),
);
router.get(
  "/service-invoices",
  requireAnyPermission(["service-invoices.read", "module.service-invoices"]),
  rangeHandler(getServiceInvoices),
);
router.get(
  "/subscriptions",
  requireAnyPermission(["subscriptions.read", "module.subscriptions"]),
  rangeHandler(getSubscriptions),
);

export default router;
