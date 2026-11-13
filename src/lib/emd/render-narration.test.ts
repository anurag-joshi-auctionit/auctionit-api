import { describe, expect, it } from "vitest";
import {
  EMD_FORFEITED_NARRATION,
  EMD_NARRATION_TEMPLATES,
  EMD_REFUND_PROCESSED_NARRATION,
} from "@auctionit/messages/emd";
import { renderNarration } from "./render-narration.js";

describe("renderNarration", () => {
  it("fills placeholders", () => {
    expect(
      renderNarration(EMD_NARRATION_TEMPLATES.emd_deposit, {
        utr: "HDFCR52026100567400062",
      }),
    ).toBe("EMD Deposit by HDFCR52026100567400062");
    expect(
      renderNarration(EMD_NARRATION_TEMPLATES.blocked_bidder_attached, {
        auctionNo: "JSAW/e-Sales/2025-26/FA-12",
      }),
    ).toBe("EMD Blocked for JSAW/e-Sales/2025-26/FA-12 for Lots Attached");
    expect(
      renderNarration(EMD_NARRATION_TEMPLATES.release_lot_rejected, {
        auctionNo: "A-1",
      }),
    ).toBe("EMD Release for A-1 for Lot Rejected");
    expect(
      renderNarration(EMD_NARRATION_TEMPLATES.release_by_admin, {
        auctionNo: "A-1",
        remarks: "Partial unblock",
      }),
    ).toBe("EMD Release for A-1 for Partial unblock");
  });

  it("renders refund and forfeiture narrations", () => {
    expect(
      renderNarration(EMD_NARRATION_TEMPLATES.refund_rejected, {
        refundId: 12,
        remarks: "Bank details mismatch",
      }),
    ).toBe("EMD Refund Rejected #12 for Bank details mismatch");
    expect(
      renderNarration(EMD_REFUND_PROCESSED_NARRATION, {
        refundId: 12,
        txnRefNo: "CMS5670880754",
        date: "11-May-2026",
      }),
    ).toBe("EMD Refund Processed #12 by CMS5670880754 on 11-May-2026");
    expect(
      renderNarration(EMD_FORFEITED_NARRATION, {
        auctionNo: "A-1",
        reason: "Lifting not completed within window",
      }),
    ).toBe("EMD Forfeited for A-1 for Lifting not completed within window");
  });

  it("drops empty groups", () => {
    expect(renderNarration("Correction ({remarks})", {})).toBe("Correction");
    expect(renderNarration("Correction ({remarks})", { remarks: "Wrong bidder" })).toBe(
      "Correction (Wrong bidder)",
    );
  });
});
