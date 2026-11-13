import { paginated } from "../common.js";
import { z } from "../zod.js";

// Mirrors the return types in services/bidders.service.ts, services/users.service.ts
// (bidder users), services/bidder-documents.service.ts, services/bidder-bank-accounts.service.ts
// and services/subscriptions.service.ts (per-bidder subscriptions).

// ---- Bidders ----

export const BidderCounts = z
  .object({
    total: z.number().int(),
    active: z.number().int(),
    inactive: z.number().int(),
    newLast30d: z.number().int().openapi({ description: "Bidders created in the last 30 IST days." }),
    unverified: z.number().int(),
  })
  .openapi("BidderCounts");

export const BidderListItem = z
  .object({
    bidderId: z.number().int(),
    companyName: z.string(),
    pan: z.string().nullable(),
    gstin: z.string().nullable(),
    country: z.string().nullable(),
    state: z.string().nullable(),
    city: z.string().nullable(),
    locationId: z.number().int().nullable(),
    contactName: z.string().nullable(),
    contactEmail: z.string().nullable(),
    contactPhone: z.string().nullable(),
    materials: z.array(z.number().int()).openapi({ description: "Material ids the bidder deals in." }),
    emd: z.number().nullable().openapi({ description: "Available EMD balance." }),
    van: z.string().nullable().openapi({ description: "Virtual account number for EMD deposits." }),
    isActive: z.boolean(),
    isVerified: z.boolean(),
    isSubscribed: z.boolean(),
    createdAt: z.string(),
    auctionCount: z.number().int(),
    lastAuctionDate: z.string().nullable(),
  })
  .openapi("BidderListItem");

export const BidderList = paginated(BidderListItem, { counts: BidderCounts }).openapi("BidderList");

export const BidderCreated = z
  .object({
    bidderId: z.number().int(),
    userId: z.number().int().openapi({ description: "Login user created for the bidder." }),
  })
  .openapi("BidderCreated");

const BidderBlockFields = {
  id: z.number().int().openapi({ description: "Block log id." }),
  clientId: z.number().int(),
  clientName: z.string().nullable(),
  isBlocked: z.boolean(),
  reason: z.string().nullable(),
  createdAt: z.string(),
  blockedByName: z.string().nullable(),
};

export const BidderDetail = z
  .object({
    bidderId: z.number().int(),
    companyName: z.string(),
    isActive: z.boolean(),
    isVerified: z.boolean(),
    createdAt: z.string(),
    contactEmail: z.string().nullable().openapi({ description: "Email of the linked login user." }),
    contactPhone: z.string().nullable(),
    profile: z.object({
      address: z.string().nullable(),
      locationId: z.number().int().nullable(),
      country: z.string().nullable(),
      state: z.string().nullable(),
      city: z.string().nullable(),
      pincode: z.string().nullable(),
      website: z.string().nullable(),
      pan: z.string().nullable(),
      gstin: z.string().nullable(),
      materials: z.array(z.number().int()),
      emd: z.number().nullable(),
      van: z.string().nullable(),
      validFrom: z.string().nullable(),
      validTo: z.string().nullable(),
    }),
    blocks: z
      .array(z.object(BidderBlockFields))
      .openapi({ description: "Currently always empty; use `GET /bidders/{id}/blocks`." }),
    mappings: z
      .array(
        z.object({
          id: z.number().int(),
          clientId: z.number().int(),
          clientName: z.string().nullable(),
          bidderCode: z.string().nullable(),
          allMaterialLocation: z.boolean(),
          isActive: z.boolean().nullable(),
          isBlocked: z.boolean(),
          isRefunded: z.boolean().nullable(),
          createDatetime: z.string(),
        }),
      )
      .openapi({ description: "Currently always empty." }),
  })
  .openapi("BidderDetail");

export const BidderDetailResponse = z.object({ bidder: BidderDetail }).openapi("BidderDetailResponse");

export const BidderStatusResult = z
  .object({
    ok: z.literal(true),
    removedFromUpcomingLots: z
      .number()
      .int()
      .openapi({ description: "Lot mappings removed from not-yet-started lots (only when set unverified)." }),
    releasedEmdAuctions: z
      .number()
      .int()
      .openapi({ description: "Auctions whose EMD hold was released (only when set unverified)." }),
  })
  .openapi("BidderStatusResult");

export const BidderOptions = z
  .object({
    options: z.array(z.object({ bidderId: z.number().int(), companyName: z.string() })),
  })
  .openapi("BidderOptions");

export const BidderPaymentTypes = z
  .object({
    paymentTypes: z.array(z.object({ paymentTypeId: z.number().int(), name: z.string() })),
  })
  .openapi("BidderPaymentTypes");

// ---- Blocks / exemptions ----

export const BidderBlockList = paginated(z.object(BidderBlockFields).openapi("BidderBlockListItem")).openapi(
  "BidderBlockList",
);

const BidderExemptionFields = {
  id: z.number().int().openapi({ description: "Exemption log id." }),
  clientId: z.number().int(),
  clientName: z.string().nullable(),
  isExempted: z.boolean(),
  reason: z.string().nullable(),
  createdAt: z.string(),
  exemptedByName: z.string().nullable(),
};

export const BidderExemptionList = paginated(
  z.object(BidderExemptionFields).openapi("BidderExemptionListItem"),
).openapi("BidderExemptionList");

export const BlockedBidderList = paginated(
  z
    .object({
      logId: z.number().int(),
      bidderId: z.number().int(),
      companyName: z.string(),
      clientId: z.number().int(),
      clientName: z.string().nullable(),
      reason: z.string().nullable(),
      blockedAt: z.string(),
      blockedByName: z.string().nullable(),
    })
    .openapi("BlockedBidderItem"),
).openapi("BlockedBidderList");

export const ExemptedBidderList = paginated(
  z
    .object({
      logId: z.number().int(),
      bidderId: z.number().int(),
      companyName: z.string(),
      clientId: z.number().int(),
      clientName: z.string().nullable(),
      reason: z.string().nullable(),
      exemptedAt: z.string(),
      exemptedByName: z.string().nullable(),
    })
    .openapi("ExemptedBidderItem"),
).openapi("ExemptedBidderList");

// ---- Documents ----

export const BidderDocument = z
  .object({
    id: z.number().int(),
    documentTypeId: z.number().int(),
    documentTypeName: z.string(),
    fileName: z.string().nullable(),
    previewUrl: z.string().nullable().openapi({ description: "Short-lived signed download URL." }),
    createdAt: z.string().nullable(),
    createdBy: z.number().int().nullable(),
    createdByName: z.string().nullable(),
  })
  .openapi("BidderDocument");

export const BidderDocumentList = paginated(BidderDocument).openapi("BidderDocumentList");

export const BidderDocumentUploaded = z.object({ document: BidderDocument }).openapi("BidderDocumentUploaded");

export const BidderDocumentTypes = z
  .object({
    documentTypes: z.array(
      z.object({
        documentTypeId: z.number().int(),
        name: z.string(),
        fileNamePrefix: z.string(),
      }),
    ),
    allowedExtensions: z
      .array(z.string())
      .openapi({ example: ["jpg", "jpeg", "png", "webp", "pdf", "doc", "docx", "xls", "xlsx"] }),
  })
  .openapi("BidderDocumentTypes");

// ---- Bank account (live row) ----

export const BidderBankAccount = z
  .object({
    bankAccount: z.string().nullable(),
    bankName: z.string().nullable(),
    bankIfsc: z.string().nullable(),
    cancelledChequeFileName: z.string().nullable(),
    cancelledCheckUrl: z.string().nullable().openapi({ description: "Signed URL of the latest cancelled cheque." }),
    isVerified: z.boolean(),
    reviewedAt: z.string().nullable(),
    reviewedBy: z.number().int().nullable(),
    reviewedByName: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string().nullable(),
  })
  .openapi("BidderBankAccount");

export const BidderBankAccountNullableResponse = z
  .object({ bankAccount: BidderBankAccount.nullable() })
  .openapi("BidderBankAccountNullableResponse");

export const BidderBankAccountResponse = z
  .object({ bankAccount: BidderBankAccount })
  .openapi("BidderBankAccountResponse");

// ---- Users ----

export const BidderUser = z
  .object({
    userId: z.number().int(),
    name: z.string(),
    userLoginName: z.string(),
    emailId: z.string().nullable(),
    phoneNumber: z.string().nullable(),
    whatsappNumber: z.string().nullable(),
    designation: z.string().nullable(),
    isActive: z.boolean(),
    lastLoginAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("BidderUser");

export const BidderUserList = paginated(BidderUser).openapi("BidderUserList");

export const BidderUserCreated = z.object({ userId: z.number().int() }).openapi("BidderUserCreated");

export const BidderUserErrorBody = z
  .object({
    error: z.string(),
    code: z.enum(["OTP_MISSING_EMAIL", "OTP_DELIVERY_FAILED"]),
  })
  .openapi("BidderUserErrorBody");

// ---- Subscriptions ----

export const BidderSubscriptionEntry = z
  .object({
    id: z.number().int(),
    bidderId: z.number().int(),
    bidderName: z.string().nullable(),
    subscriptionTypeId: z.number().int(),
    subscriptionTypeName: z.string().nullable(),
    fromDate: z.string().nullable(),
    toDate: z.string().nullable(),
    subscriptionPrice: z.number(),
    gstAmount: z.number(),
    amount: z.number(),
    paymentMode: z.number().int().nullable(),
    paymentModeName: z.string().nullable(),
    transactionId: z.string().nullable(),
    paymentDate: z.string().nullable(),
    remarks: z.string().nullable(),
    createdAt: z.string(),
    invoiceStatus: z.enum(["requested", "recheck", "generated", "cancelled"]),
    invoiceNumber: z.string().nullable(),
    invoiceDate: z.string().nullable(),
    invoicePdfFilename: z.string().nullable(),
    invoicePdfS3Key: z.string().nullable(),
    invoicePdfUrl: z.string().nullable(),
    invoiceRequestedAt: z.string().nullable(),
    invoiceGeneratedAt: z.string().nullable(),
    invoiceRecheckedAt: z.string().nullable(),
    invoiceCancelledAt: z.string().nullable(),
    emailSentAt: z.string().nullable(),
    emailSentBy: z.number().int().nullable(),
    emailSentByName: z.string().nullable(),
  })
  .openapi("BidderSubscriptionEntry");

export const BidderSubscriptionStatus = z
  .object({
    active: z.boolean(),
    activeFrom: z.string().nullable(),
    activeUntil: z.string().nullable(),
    currentTypeName: z.string().nullable(),
  })
  .openapi("BidderSubscriptionStatus");

export const BidderSubscriptionList = paginated(BidderSubscriptionEntry, {
  status: BidderSubscriptionStatus,
  totalAmount: z.number().openapi({ description: "Sum of `amount` over all rows." }),
  subscriberCount: z.number().int(),
}).openapi("BidderSubscriptionList");

export const BidderSubscriptionQuote = z
  .object({
    subscriptionTypeId: z.number().int(),
    name: z.string(),
    amount: z.number().openapi({ description: "Plan total including GST." }),
    gstPercent: z.number(),
    subscriptionPrice: z.number(),
    gstAmount: z.number(),
    fromDate: z.string().openapi({ description: "First day of the start month (YYYY-MM-01)." }),
    toDate: z.string().nullable(),
  })
  .openapi("BidderSubscriptionQuote");

export const BidderSubscriptionRecorded = z
  .object({
    ok: z.literal(true),
    id: z.number().int().openapi({ description: "New subscription payment id." }),
    alreadyActive: z
      .boolean()
      .openapi({ description: "True when the bidder already had an active subscription before this payment." }),
  })
  .openapi("BidderSubscriptionRecorded");
