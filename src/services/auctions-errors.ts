import { AuctionsErrorMessages } from "@auctionit/messages/auctions";

export class AuctionNotFoundError extends Error {
  constructor() {
    super(AuctionsErrorMessages.AUCTION_NOT_FOUND);
    this.name = "AuctionNotFoundError";
  }
}

export class AuctionValidationError extends Error {
  fieldErrors?: Record<string, string[]>;

  constructor(message: string, fieldErrors?: Record<string, string[]>) {
    super(message);
    this.name = "AuctionValidationError";
    this.fieldErrors = fieldErrors;
  }
}
