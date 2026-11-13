import { BiddersValidationMessages } from "@auctionit/messages/bidders";
import {
  GSTIN_REGEX,
  INDIAN_MOBILE_REGEX,
  isValidWebsiteUrl,
  normalizeGstinInput,
  normalizePanInput,
  normalizePincodeInput,
  PAN_REGEX,
  PINCODE_REGEX,
} from "@auctionit/lib/validation";
import { z } from "zod";
import {
  nullableEmailSchema as buildNullableEmailSchema,
  nullableIndianPhoneSchema as buildNullableIndianPhoneSchema,
  nullableNormalized,
  requiredEmailSchema as buildRequiredEmailSchema,
  requiredIndianPhoneSchema,
  requiredNormalized,
  requiredString,
} from "../validation/normalized-string.js";

export { GSTIN_REGEX, INDIAN_MOBILE_REGEX, PAN_REGEX, PINCODE_REGEX };

export const requiredPincodeSchema = requiredNormalized(
  normalizePincodeInput,
  BiddersValidationMessages.PINCODE_REQUIRED,
  PINCODE_REGEX,
  BiddersValidationMessages.INVALID_PINCODE,
);

export const requiredPhoneSchema = requiredIndianPhoneSchema(
  BiddersValidationMessages.PHONE_REQUIRED,
  BiddersValidationMessages.INVALID_PHONE,
);

export const nullableIndianPhoneSchema = buildNullableIndianPhoneSchema(
  BiddersValidationMessages.INVALID_PHONE,
);

export const requiredEmailSchema = buildRequiredEmailSchema(
  BiddersValidationMessages.EMAIL_REQUIRED,
  BiddersValidationMessages.INVALID_EMAIL,
  250,
);

export const requiredPanSchema = requiredNormalized(
  normalizePanInput,
  BiddersValidationMessages.PAN_REQUIRED,
  PAN_REGEX,
  BiddersValidationMessages.INVALID_PAN,
);

export const requiredGstinSchema = requiredNormalized(
  normalizeGstinInput,
  BiddersValidationMessages.GSTIN_REQUIRED,
  GSTIN_REGEX,
  BiddersValidationMessages.INVALID_GSTIN,
);

export const requiredStr = (max: number, message: string) =>
  requiredString(message).max(max);

export const locationIdSchema = z
  .number({
    required_error: BiddersValidationMessages.LOCATION_REQUIRED,
    invalid_type_error: BiddersValidationMessages.LOCATION_REQUIRED,
  })
  .int()
  .positive(BiddersValidationMessages.LOCATION_REQUIRED);

export const materialIdsSchema = z.array(z.number().int().positive());

export const requiredMaterialIdsSchema = materialIdsSchema.min(
  1,
  BiddersValidationMessages.MATERIALS_REQUIRED,
);

export const nullableStr = (max: number) =>
  z
    .union([z.string().trim().max(max), z.literal("")])
    .nullish()
    .transform((v): string | null | undefined => (v === "" ? null : v));

export const nullableWebsiteSchema = z
  .union([
    z
      .string()
      .trim()
      .max(100)
      .refine(isValidWebsiteUrl, {
        message: BiddersValidationMessages.INVALID_WEBSITE,
      }),
    z.literal(""),
  ])
  .nullish()
  .transform((v): string | null | undefined => (v === "" ? null : v));

export const nullableEmailSchema = buildNullableEmailSchema(
  BiddersValidationMessages.INVALID_EMAIL,
  250,
);

export const nullablePanSchema = nullableNormalized(
  normalizePanInput,
  PAN_REGEX,
  BiddersValidationMessages.INVALID_PAN,
);

export const nullableGstinSchema = nullableNormalized(
  normalizeGstinInput,
  GSTIN_REGEX,
  BiddersValidationMessages.INVALID_GSTIN,
);

export const pincodeSchema = nullableNormalized(
  normalizePincodeInput,
  PINCODE_REGEX,
  BiddersValidationMessages.INVALID_PINCODE,
);

const bidderProfileFieldsSchema = z.object({
  address: nullableStr(1000),
  locationId: locationIdSchema,
  pincode: requiredPincodeSchema,
  materials: requiredMaterialIdsSchema,
  website: nullableWebsiteSchema,
  pan: requiredPanSchema,
  gstin: requiredGstinSchema,
});

/** Login user created together with a new bidder (admin create / signup). */
export const bidderUserCreateFieldsSchema = z.object({
  name: requiredStr(100, BiddersValidationMessages.NAME_REQUIRED),
  userLoginName: z
    .string()
    .trim()
    .min(1, BiddersValidationMessages.USERNAME_REQUIRED)
    .max(50),
  emailId: requiredEmailSchema,
  phoneNumber: requiredPhoneSchema,
  whatsappNumber: nullableIndianPhoneSchema,
  designation: nullableStr(100),
  isActive: z.boolean().optional(),
});

export const BIDDER_SORT_FIELDS = [
  "companyName",
  "emd",
  "isActive",
  "createdAt",
  "auctionCount",
  "lastAuctionDate",
] as const;

export const BIDDER_DATE_FILTER_FIELDS = ["createdAt", "lastAuctionDate"] as const;

export const biddersListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  status: z
    .enum([
      "all",
      "active",
      "inactive",
      "verified",
      "unverified",
      "subscribed",
      "unsubscribed",
    ])
    .optional(),
  sortBy: z.enum(BIDDER_SORT_FIELDS).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  dateField: z.enum(BIDDER_DATE_FILTER_FIELDS).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

export const blockedBiddersListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  sortBy: z.enum(["companyName", "blockedAt"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export const exemptedBiddersListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  sortBy: z.enum(["companyName", "exemptedAt"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export const bidderBlocksListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  sortBy: z.enum(["blockedAt"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export const bidderExemptionsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  sortBy: z.enum(["exemptedAt"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export const bidderDocumentsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  sortBy: z
    .enum(["documentTypeName", "fileName", "createdAt", "createdByName"])
    .optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export type BiddersListParams = z.infer<typeof biddersListQuerySchema>;
export type BidderStatusFilter = NonNullable<BiddersListParams["status"]>;
export type BlockedBiddersListParams = z.infer<
  typeof blockedBiddersListQuerySchema
>;
export type ExemptedBiddersListParams = z.infer<
  typeof exemptedBiddersListQuerySchema
>;
export type BidderBlocksListParams = z.infer<typeof bidderBlocksListQuerySchema>;
export type BidderExemptionsListParams = z.infer<
  typeof bidderExemptionsListQuerySchema
>;
export type BidderDocumentsListParams = z.infer<
  typeof bidderDocumentsListQuerySchema
>;

export const createBidderSchema = bidderProfileFieldsSchema.extend({
  companyName: z
    .string()
    .trim()
    .min(1, BiddersValidationMessages.COMPANY_NAME_REQUIRED)
    .max(100),
  isActive: z.boolean().optional(),
  isVerified: z.boolean().optional(),
  validFrom: z.string().nullable().optional(),
  validTo: z.string().nullable().optional(),
  user: bidderUserCreateFieldsSchema,
});

export type CreateBidderInput = z.infer<typeof createBidderSchema>;

/**
 * Public bidder self-registration (/signup). Company profile + login user.
 * Password is generated server-side and emailed.
 */
export const bidderSignupSchema = bidderProfileFieldsSchema
  .omit({ address: true })
  .extend({
    companyName: z
      .string()
      .trim()
      .min(1, BiddersValidationMessages.COMPANY_NAME_REQUIRED)
      .max(100),
    name: requiredStr(100, BiddersValidationMessages.NAME_REQUIRED),
    userLoginName: z
      .string()
      .trim()
      .min(1, BiddersValidationMessages.USERNAME_REQUIRED)
      .max(50),
    emailId: requiredEmailSchema,
    phoneNumber: requiredPhoneSchema,
    whatsappNumber: nullableIndianPhoneSchema,
  });

export type BidderSignupInput = z.infer<typeof bidderSignupSchema>;

export const bidderInfoSchema = bidderProfileFieldsSchema.extend({
  companyName: z
    .string()
    .trim()
    .min(1, BiddersValidationMessages.COMPANY_NAME_REQUIRED)
    .max(100),
  validFrom: z.string().nullable().optional(),
  validTo: z.string().nullable().optional(),
});

export const bidderStatusSchema = z.object({
  isActive: z.boolean(),
  isVerified: z.boolean(),
});

export type BidderInfoInput = z.infer<typeof bidderInfoSchema>;

const requiredPositiveInt = (message: string) =>
  z.coerce
    .number({
      required_error: message,
      invalid_type_error: message,
    })
    .int(message)
    .positive(message);

const blockBidderReasonSchema = z
  .string()
  .trim()
  .min(1, BiddersValidationMessages.BLOCK_REASON_REQUIRED)
  .max(500, BiddersValidationMessages.BLOCK_REASON_MAX);

/** Bidder-scoped POST /bidders/:id/blocks — bidderId from URL. */
export const blockBidderBodySchema = z.object({
  clientId: requiredPositiveInt(BiddersValidationMessages.CLIENT_REQUIRED),
  reason: blockBidderReasonSchema,
});

/** Collection POST /bidders/blocks — bidderId in body (admin picker flow). */
export const blockBidderCreateBodySchema = z.object({
  bidderId: requiredPositiveInt(BiddersValidationMessages.BIDDER_REQUIRED),
  clientId: requiredPositiveInt(BiddersValidationMessages.CLIENT_REQUIRED),
  reason: blockBidderReasonSchema,
});

const exemptBidderReasonSchema = z
  .string()
  .trim()
  .min(1, BiddersValidationMessages.EXEMPT_REASON_REQUIRED)
  .max(500, BiddersValidationMessages.EXEMPT_REASON_MAX);

/** Bidder-scoped POST /bidders/:id/exemptions — bidderId from URL. */
export const exemptBidderBodySchema = z.object({
  clientId: requiredPositiveInt(BiddersValidationMessages.CLIENT_REQUIRED),
  reason: exemptBidderReasonSchema,
});

/** Collection POST /bidders/exemptions — bidderId in body (admin picker flow). */
export const exemptBidderCreateBodySchema = z.object({
  bidderId: requiredPositiveInt(BiddersValidationMessages.BIDDER_REQUIRED),
  clientId: requiredPositiveInt(BiddersValidationMessages.CLIENT_REQUIRED),
  reason: exemptBidderReasonSchema,
});

const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export const bidderBankAccountBodySchema = z.object({
  bankAccount: z
    .string()
    .trim()
    .min(1, BiddersValidationMessages.BANK_ACCOUNT_REQUIRED)
    .max(30, BiddersValidationMessages.BANK_ACCOUNT_MAX)
    .regex(/^\d+$/, BiddersValidationMessages.BANK_ACCOUNT_INVALID),
  bankName: z
    .string()
    .trim()
    .min(1, BiddersValidationMessages.BANK_NAME_REQUIRED)
    .max(200, BiddersValidationMessages.BANK_NAME_MAX),
  bankIfsc: z
    .string()
    .trim()
    .min(1, BiddersValidationMessages.BANK_IFSC_REQUIRED)
    .toUpperCase()
    .regex(IFSC_REGEX, BiddersValidationMessages.BANK_IFSC_INVALID),
  chequeBase64: z.string().trim().min(1).optional(),
});

export type BidderBankAccountBody = z.infer<typeof bidderBankAccountBodySchema>;

export const bidderDocumentUploadFieldsSchema = z.object({
  documentTypeId: z.coerce
    .number({
      required_error: BiddersValidationMessages.DOCUMENT_TYPE_REQUIRED,
      invalid_type_error: BiddersValidationMessages.DOCUMENT_TYPE_REQUIRED,
    })
    .int()
    .positive(BiddersValidationMessages.DOCUMENT_TYPE_REQUIRED),
});

export type BidderDocumentUploadFields = z.infer<
  typeof bidderDocumentUploadFieldsSchema
>;

/** @deprecated Use bidderDocumentUploadFieldsSchema (multipart uploads). */
export const bidderDocumentUploadBodySchema = bidderDocumentUploadFieldsSchema;
export type BidderDocumentUploadBody = BidderDocumentUploadFields;

export {
  bidderSubscriptionBodySchema,
  type BidderSubscriptionBody,
} from "../subscriptions/schemas.js";
