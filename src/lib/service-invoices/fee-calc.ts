import type { ServiceFeeType } from "@auctionit/messages/clients";

export type FeeCalcInput = {
  serviceFeeType: ServiceFeeType;
  serviceFeeValue: number;
  totalQuantity: number;
  totalAmount: number;
  gstPercent: number;
};

export type FeeCalcResult = {
  serviceFeeAmount: number;
  gstAmount: number;
  /** Actual sum (fee + GST), not ceiled. */
  grandTotal: number;
  /** Display adjustment so UI grand total is a whole number (ceil − actual). */
  roundOff: number;
};

/** Pre-GST fee from unified fee fields. */
export function computeServiceFeeAmount(
  type: ServiceFeeType,
  serviceFeeValue: number,
  totalQuantity: number,
  totalAmount: number,
): number {
  switch (type) {
    case "service_percentage":
      return serviceFeeValue * totalAmount;
    case "pmt":
      return serviceFeeValue * totalQuantity;
    case "fixed_amount":
      return serviceFeeValue;
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

export function computeFeeTotals(input: FeeCalcInput): FeeCalcResult {
  const rawFee = computeServiceFeeAmount(
    input.serviceFeeType,
    input.serviceFeeValue,
    input.totalQuantity,
    input.totalAmount,
  );
  const serviceFeeAmount = round3(rawFee);
  const gstAmount = round2((rawFee * input.gstPercent) / 100);
  const grandTotal = round3(serviceFeeAmount + gstAmount);
  const roundOff = round2(
    Math.ceil(Number(grandTotal.toFixed(3))) - grandTotal,
  );
  return {
    serviceFeeAmount,
    gstAmount,
    roundOff,
    grandTotal,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
