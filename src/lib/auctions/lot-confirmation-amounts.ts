export type LotConfirmationLineAmounts = {
  price: number;
  gstAmount: number;
  pricePlusGst: number;
  tcsAmount: number;
  unitWithTax: number;
  lineTotal: number;
};

export function lotConfirmationLineAmounts(opts: {
  winningAmount: number;
  quantity: number;
  gstPercentage: number;
  tcsPercentage: number;
}): LotConfirmationLineAmounts {
  const price = opts.winningAmount;
  const gstPct = opts.gstPercentage > 0 ? opts.gstPercentage : 0;
  const tcsPct = opts.tcsPercentage > 0 ? opts.tcsPercentage : 0;
  const gstAmount = (price * gstPct) / 100;
  const pricePlusGst = price + gstAmount;
  const tcsAmount = tcsPct > 0 ? (pricePlusGst * tcsPct) / 100 : 0;
  const unitWithTax = pricePlusGst + tcsAmount;
  const lineTotal = unitWithTax * opts.quantity;
  return { price, gstAmount, pricePlusGst, tcsAmount, unitWithTax, lineTotal };
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(3)));
}

export function formatQty(value: number): string {
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}
