import { AuctionRaStagesErrorMessages } from "@auctionit/messages/auction-ra-stages";

export class AuctionRaStageNotFoundError extends Error {
  constructor(message: string = AuctionRaStagesErrorMessages.STAGE_NOT_FOUND) {
    super(message);
    this.name = "AuctionRaStageNotFoundError";
  }
}

export class AuctionRaStageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuctionRaStageValidationError";
  }
}
