export const LOT_CONFIRMATION_R2_FOLDER = "auctions/lot-confirmations";
export const LOT_CONFIRMATION_PDF_CONTENT_TYPE = "application/pdf";

export function buildLotConfirmationPdfFilename(opts: {
  bidderId: number;
  auctionId: number;
}): string {
  return `lot-confirmation-letter-${opts.bidderId}-${opts.auctionId}.pdf`;
}

export function buildLotConfirmationPdfS3Key(opts: {
  bidderId: number;
  auctionId: number;
}): string {
  return `${LOT_CONFIRMATION_R2_FOLDER}/${buildLotConfirmationPdfFilename(opts)}`;
}
