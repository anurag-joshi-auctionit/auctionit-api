export const AuctionRaStagesValidationMessages = {
  STARTS_AT_REQUIRED: "Starts At is required — pick when this stage should open.",
  ENDS_AT_REQUIRED: "Ends At is required — pick when this stage should close.",
  ENDS_AT_BEFORE_STARTS_AT:
    "Ends At must be after Starts At — a stage needs to stay open for some time before it closes.",
  STARTS_AT_IN_PAST:
    "Starts At must be a future date and time — a stage can't be scheduled to open in the past.",
  ENDS_AT_AFTER_AUCTION_START:
    "Ends At must be before the auction starts — every sourcing stage has to finish before bidding begins.",
  STARTS_AT_BEFORE_PREVIOUS_STAGE_ENDS: (previousStageLabel: string) =>
    `Starts At must be on or after ${previousStageLabel}'s Ends At — stages run one after another, never at the same time.`,
  ENDS_AT_AFTER_NEXT_STAGE_STARTS: (nextStageLabel: string) =>
    `Ends At must be on or before ${nextStageLabel}'s Starts At — stages run one after another, never at the same time.`,
  REJECTION_REASON_REQUIRED: "Reason is required.",
  SELECT_AT_LEAST_ONE_BIDDER: "Select at least one bidder.",
  SELECT_ENTRY_STAGE_REQUIRED: "Select an entry stage for Advanced invite.",
} as const;

export const AuctionRaStagesErrorMessages = {
  STAGE_NOT_FOUND: "RA Stage not found.",
  AUCTION_NOT_REVERSE_TYPE: "RA Stages are only available for reverse auctions.",
  AUCTION_NOT_EDITABLE: "RA stages can only be edited while the auction is published.",
  STAGE_LOCKED: "This stage can no longer be edited once it has started.",
  INVITE_NOT_FOUND: "Bidder invitation not found.",
  BIDDER_NOT_INVITED: "Bidder is not invited to this stage.",
  RESPONSE_ALREADY_SUBMITTED: "This stage has already been submitted.",
  STAGE_NOT_OPEN_FOR_SUBMISSION: "This stage is not currently open for submissions.",
  CANNOT_WITHDRAW_SUBMITTED_BIDDER:
    "Cannot withdraw a bidder who has already submitted a response.",
  ENTRY_STAGE_CLOSED:
    "Cannot invite bidders — the entry stage is closed. Reopen the stage first by updating its Ends At.",
} as const;
