import { describe, expect, it } from "vitest";
import {
  matchCancelCredits,
  matchRefundDebits,
  pairTransfers,
  type LegacyRefund,
  type LegacyRow,
} from "./emd-legacy-match.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2025, 0, 10);

function row(p: Partial<LegacyRow> & { trnId: number }): LegacyRow {
  return { bidderId: 1, amount: 1000, at: T0, remark: "", payEmdId: null, processStatus: null, ...p };
}

function refund(p: Partial<LegacyRefund> & { id: number }): LegacyRefund {
  return { bidderId: 1, amount: 1000, at: T0, paid: false, cancelled: false, utr: null, ...p };
}

describe("matchRefundDebits", () => {
  it("prefers the PayEMDId link", () => {
    const m = matchRefundDebits(
      [refund({ id: 7 })],
      [row({ trnId: 1 }), row({ trnId: 2, payEmdId: 7, processStatus: 1, at: T0 + 5 * DAY })],
    );
    expect([...m]).toEqual([[2, 7]]);
  });

  it("matches a paid refund by UTR in the remark", () => {
    const m = matchRefundDebits(
      [refund({ id: 7, paid: true, utr: "ICICR42026071000584523" })],
      [row({ trnId: 1, at: T0 + 30 * DAY, remark: "EMD returned vide ICICR4202607100 dt" })],
    );
    expect(m.get(1)).toBe(7);
  });

  it("falls back to the nearest debit near the request and claims each debit once", () => {
    const m = matchRefundDebits(
      [refund({ id: 7 }), refund({ id: 8, at: T0 + 1000 })],
      [row({ trnId: 1, at: T0 + 10 }), row({ trnId: 2, at: T0 + 3 * DAY })],
    );
    expect([...m]).toEqual([[1, 7]]);
  });

  it("ignores other bidders and amounts", () => {
    const m = matchRefundDebits(
      [refund({ id: 7 })],
      [row({ trnId: 1, bidderId: 2 }), row({ trnId: 2, amount: 999 })],
    );
    expect(m.size).toBe(0);
  });
});

describe("matchCancelCredits", () => {
  it("links a cancelled refund to the nearest later credit", () => {
    const m = matchCancelCredits(
      [refund({ id: 7, cancelled: true }), refund({ id: 8 })],
      [row({ trnId: 1, at: T0 - 5 * DAY }), row({ trnId: 2, at: T0 + DAY }), row({ trnId: 3, at: T0 + 9 * DAY })],
    );
    expect([...m]).toEqual([[2, 7]]);
  });
});

describe("pairTransfers", () => {
  it("pairs the To/From rows written by the EMDTransfer proc", () => {
    const pairs = pairTransfers(
      [row({ trnId: 2, bidderId: 2004, amount: 200000, remark: "EMD Transfer To Buyer Kasmani Exim[4623]" })],
      [
        row({ trnId: 1, bidderId: 4623, amount: 200000, remark: "EMD Transfer From Buyer Kasmani Impex[2004]" }),
        row({ trnId: 3, bidderId: 4623, amount: 5000, remark: "EMD Transfer From Buyer Kasmani Impex[2004]" }),
      ],
    );
    expect(pairs).toEqual([
      {
        debitTrnId: 2,
        creditTrnId: 1,
        fromBidderId: 2004,
        toBidderId: 4623,
        amount: 200000,
        at: T0,
        remark: "EMD Transfer To Buyer Kasmani Exim[4623]",
      },
    ]);
  });

  it("leaves free-text transfer remarks unpaired", () => {
    expect(
      pairTransfers(
        [row({ trnId: 1, remark: "EMD transfers to ABC" })],
        [row({ trnId: 2, bidderId: 2, remark: "EMD Transfer From Buyer X[1]" })],
      ),
    ).toEqual([]);
  });
});
