import {
  ADDITIONAL_FIELD_DATA_TYPES,
  ADDITIONAL_FIELD_LABEL_MAX,
  ADDITIONAL_FIELD_SCOPES,
  ClientsErrorMessages,
  ClientsValidationMessages,
  isValidServiceFeeValueForType,
  SERVICE_FEE_TYPES,
  type ServiceFeeType,
} from "@auctionit/messages/clients";
import {
  EMAIL_REGEX,
  GSTIN_REGEX,
  INDIAN_MOBILE_REGEX,
  isValidWebsiteUrl,
  normalizeEmailInput,
  normalizeGstinInput,
  normalizeIndianMobileInput,
  normalizePanInput,
  normalizePincodeInput,
  normalizeTanInput,
  PAN_REGEX,
  PINCODE_REGEX,
  TAN_REGEX,
} from "@auctionit/lib/validation";
import { z } from "zod";
import {
  nullableEmailSchema as buildNullableEmailSchema,
  nullableNormalized,
  requiredEmailSchema as buildRequiredEmailSchema,
  requiredIndianPhoneSchema,
  requiredNormalized,
  requiredString,
} from "../validation/normalized-string.js";

export {
  EMAIL_REGEX,
  GSTIN_REGEX,
  INDIAN_MOBILE_REGEX,
  PAN_REGEX,
  PINCODE_REGEX,
  TAN_REGEX,
};

export const PHONE_REGEX = /^\+?\d{7,20}$/;

function parseCommaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function lowercaseCommaSeparatedEmails(value: string): string {
  return parseCommaSeparated(value).map(normalizeEmailInput).join(", ");
}

export const nullablePanSchema = nullableNormalized(
  normalizePanInput,
  PAN_REGEX,
  ClientsValidationMessages.INVALID_PAN,
);

export const nullableTanSchema = nullableNormalized(
  normalizeTanInput,
  TAN_REGEX,
  ClientsValidationMessages.INVALID_TAN,
);

export const nullableGstinSchema = nullableNormalized(
  normalizeGstinInput,
  GSTIN_REGEX,
  ClientsValidationMessages.INVALID_GSTIN,
);

export const pincodeSchema = nullableNormalized(
  normalizePincodeInput,
  PINCODE_REGEX,
  ClientsValidationMessages.INVALID_PINCODE,
);

export const requiredPincodeSchema = requiredNormalized(
  normalizePincodeInput,
  ClientsValidationMessages.PINCODE_REQUIRED,
  PINCODE_REGEX,
  ClientsValidationMessages.INVALID_PINCODE,
);

export const requiredPhoneSchema = requiredIndianPhoneSchema(
  ClientsValidationMessages.PHONE_REQUIRED,
  ClientsValidationMessages.INVALID_PHONE,
);

export const requiredEmailSchema = buildRequiredEmailSchema(
  ClientsValidationMessages.EMAIL_REQUIRED,
  ClientsValidationMessages.INVALID_EMAIL,
);

export const requiredPanSchema = requiredNormalized(
  normalizePanInput,
  ClientsValidationMessages.PAN_REQUIRED,
  PAN_REGEX,
  ClientsValidationMessages.INVALID_PAN,
);

export const requiredGstinSchema = requiredNormalized(
  normalizeGstinInput,
  ClientsValidationMessages.GSTIN_REQUIRED,
  GSTIN_REGEX,
  ClientsValidationMessages.INVALID_GSTIN,
);

export const locationIdSchema = z
  .number({
    required_error: ClientsValidationMessages.LOCATION_REQUIRED,
    invalid_type_error: ClientsValidationMessages.LOCATION_REQUIRED,
  })
  .int()
  .positive(ClientsValidationMessages.LOCATION_REQUIRED);

export const materialIdsSchema = z.array(z.number().int().positive());

export const requiredMaterialIdsSchema = materialIdsSchema.min(
  1,
  ClientsValidationMessages.MATERIALS_REQUIRED,
);

export const serviceFeeTypeSchema = z.enum(SERVICE_FEE_TYPES, {
  required_error: ClientsValidationMessages.SERVICE_FEE_TYPE_REQUIRED,
  invalid_type_error: ClientsValidationMessages.SERVICE_FEE_TYPE_REQUIRED,
});

export const requiredServiceFeeValueSchema = z.number({
  required_error: ClientsValidationMessages.SERVICE_FEE_VALUE_REQUIRED,
  invalid_type_error: ClientsValidationMessages.SERVICE_FEE_VALUE_REQUIRED,
});

function serviceFeeValueIssueMessage(type: ServiceFeeType): string {
  if (type === "service_percentage") {
    return ClientsValidationMessages.SERVICE_FEE_PERCENTAGE_INVALID;
  }
  return ClientsValidationMessages.SERVICE_FEE_VALUE_POSITIVE;
}

export const CLIENT_SORT_FIELDS = [
  "companyName",
  "serviceFeeValue",
  "isActive",
  "createdAt",
] as const;

export const requiredStr = (max: number, message: string) =>
  requiredString(message).max(max);

export const requiredCommaSeparatedEmails = (
  max: number,
  requiredMessage: string = ClientsValidationMessages.POC_EMAIL_REQUIRED,
) =>
  z
    .string({
      required_error: requiredMessage,
      invalid_type_error: requiredMessage,
    })
    .trim()
    .max(max)
    .superRefine((value, ctx) => {
      const emails = parseCommaSeparated(value);
      if (emails.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: requiredMessage,
        });
        return;
      }
      if (!emails.every((email) => EMAIL_REGEX.test(email))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: ClientsValidationMessages.INVALID_EMAIL,
        });
      }
    })
    .transform(lowercaseCommaSeparatedEmails);

export const requiredCommaSeparatedPhones = (max: number) =>
  requiredString(ClientsValidationMessages.POC_PHONE_REQUIRED)
    .max(max)
    .refine(
      (value) => {
        const phones = parseCommaSeparated(value).map(
          normalizeIndianMobileInput,
        );
        return (
          phones.length > 0 &&
          phones.every((phone) => INDIAN_MOBILE_REGEX.test(phone))
        );
      },
      { message: ClientsValidationMessages.INVALID_PHONE },
    )
    .transform((value) =>
      parseCommaSeparated(value)
        .map(normalizeIndianMobileInput)
        .join(", "),
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
        message: ClientsValidationMessages.INVALID_WEBSITE,
      }),
    z.literal(""),
  ])
  .nullish()
  .transform((v): string | null | undefined => (v === "" ? null : v));

export const nullableEmailSchema = buildNullableEmailSchema(
  ClientsValidationMessages.INVALID_EMAIL,
);

export const nullableCommaSeparatedEmails = (max: number) =>
  z
    .union([
      z
        .string()
        .trim()
        .max(max)
        .refine(
          (value) => {
            if (!value) return true;
            const emails = parseCommaSeparated(value);
            if (emails.length === 0) return false;
            return emails.every((email) => EMAIL_REGEX.test(email));
          },
          { message: ClientsValidationMessages.INVALID_EMAIL },
        )
        .transform(lowercaseCommaSeparatedEmails),
      z.literal(""),
    ])
    .nullish()
    .transform((v): string | null | undefined => (v === "" ? null : v));

export class KamUserNotFoundError extends Error {
  constructor() {
    super(ClientsErrorMessages.KAM_USER_NOT_FOUND);
    this.name = "KamUserNotFoundError";
  }
}

export const clientsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  status: z.enum(["all", "active", "inactive"]).optional(),
  sortBy: z.enum(CLIENT_SORT_FIELDS).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  dateField: z.enum(["createdAt"]).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

export type ClientsListParams = z.infer<typeof clientsListQuerySchema>;
export type ClientStatusFilter = NonNullable<ClientsListParams["status"]>;

export const clientDocumentsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  sortBy: z
    .enum(["documentTypeName", "fileName", "createdAt", "createdByName"])
    .optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export type ClientDocumentsListParams = z.infer<
  typeof clientDocumentsListQuerySchema
>;

export const MAPPED_BIDDER_SORT_FIELDS = [
  "companyName",
  "auctionCount",
  "lastAuctionDate",
] as const;

export const mappedBiddersListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  sortBy: z.enum(MAPPED_BIDDER_SORT_FIELDS).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export type MappedBiddersListParams = z.infer<
  typeof mappedBiddersListQuerySchema
>;

export const companyInfoSchema = z.object({
  address: requiredString(ClientsValidationMessages.ADDRESS_REQUIRED).max(
    200,
    ClientsValidationMessages.ADDRESS_MAX,
  ),
  locationId: locationIdSchema,
  pincode: requiredPincodeSchema,
  materials: requiredMaterialIdsSchema,
  phone: requiredPhoneSchema,
  website: nullableWebsiteSchema,
  email: requiredEmailSchema,
  pan: requiredPanSchema,
  tan: nullableTanSchema,
  gstin: requiredGstinSchema,
  isActive: z.boolean().optional(),
});

export type CompanyInfoInput = z.infer<typeof companyInfoSchema>;

export const companyInfoUpdateSchema = companyInfoSchema
  .extend({
    serviceFeeType: serviceFeeTypeSchema,
    serviceFeeValue: requiredServiceFeeValueSchema,
  })
  .superRefine((data, ctx) => {
    if (!isValidServiceFeeValueForType(data.serviceFeeType, data.serviceFeeValue)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["serviceFeeValue"],
        message: serviceFeeValueIssueMessage(data.serviceFeeType),
      });
    }
  });

export type CompanyInfoUpdateInput = z.infer<typeof companyInfoUpdateSchema>;

const auctionSettingsBaseSchema = z.object({
  auctionPrefix: requiredStr(
    30,
    ClientsValidationMessages.AUCTION_PREFIX_REQUIRED,
  ),
  serviceFeeType: serviceFeeTypeSchema,
  serviceFeeValue: requiredServiceFeeValueSchema,
  /** Derived on save from last-bid numbers; accepted for API compatibility. */
  isLastBidExtension: z.boolean(),
  lastBidExtensionWindow: z
    .number()
    .int(ClientsValidationMessages.EXTEND_WINDOW_RANGE)
    .min(0, ClientsValidationMessages.EXTEND_WINDOW_RANGE)
    .max(120, ClientsValidationMessages.EXTEND_WINDOW_RANGE),
  lastBidExtensionInterval: z
    .number()
    .int(ClientsValidationMessages.EXTEND_INTERVAL_RANGE)
    .min(0, ClientsValidationMessages.EXTEND_INTERVAL_RANGE),
  lastBidExtensionCountMax: z
    .number()
    .int(ClientsValidationMessages.EXTEND_FREQUENCY_RANGE)
    .min(0, ClientsValidationMessages.EXTEND_FREQUENCY_RANGE),
  /** Authoritative stagger gate — persisted as sent, never derived. */
  isStaggered: z.boolean(),
  staggerInterval: z
    .number()
    .int(ClientsValidationMessages.STAGGER_INTERVAL_RANGE)
    .min(0, ClientsValidationMessages.STAGGER_INTERVAL_RANGE),
});

export const auctionSettingsSchema = auctionSettingsBaseSchema.superRefine(
  (data, ctx) => {
    if (!isValidServiceFeeValueForType(data.serviceFeeType, data.serviceFeeValue)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["serviceFeeValue"],
        message: serviceFeeValueIssueMessage(data.serviceFeeType),
      });
    }

    const window = data.lastBidExtensionWindow;
    const interval = data.lastBidExtensionInterval;
    const max = data.lastBidExtensionCountMax;
    const allZero = window === 0 && interval === 0 && max === 0;
    const allPositive = window > 0 && interval > 0 && max > 0;
    if (!allZero && !allPositive) {
      for (const path of [
        "lastBidExtensionWindow",
        "lastBidExtensionInterval",
        "lastBidExtensionCountMax",
      ] as const) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: ClientsValidationMessages.LAST_BID_EXTENSION_TRIPLE,
        });
      }
    }

    // Mirrors the clients_stagger_interval_required CHECK constraint.
    if (data.isStaggered && data.staggerInterval <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["staggerInterval"],
        message: ClientsValidationMessages.STAGGER_INTERVAL_REQUIRED,
      });
    }
  },
);

export type AuctionSettingsInput = z.infer<typeof auctionSettingsSchema>;

export const plantLocationBodySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, ClientsValidationMessages.PLANT_NAME_REQUIRED)
    .max(100),
  address: nullableStr(300),
  locationId: locationIdSchema,
  country: nullableStr(100),
  state: nullableStr(100),
  city: nullableStr(100),
  pincode: requiredPincodeSchema,
  gstin: requiredGstinSchema,
  pan: requiredPanSchema,
  pocName: requiredStr(200, ClientsValidationMessages.POC_NAME_REQUIRED),
  pocEmail: requiredCommaSeparatedEmails(200),
  pocPhone: requiredCommaSeparatedPhones(100),
  billingName: requiredStr(200, ClientsValidationMessages.BILLING_NAME_REQUIRED),
  billingEmailTo: requiredCommaSeparatedEmails(
    300,
    ClientsValidationMessages.BILLING_EMAIL_TO_REQUIRED,
  ),
  billingEmailCc: nullableCommaSeparatedEmails(500),
  gracePeriod: z.number().int().min(0).nullable().optional(),
  orderNumber: nullableStr(100),
  orderDate: z
    .union([
      z.string().datetime({ offset: true }),
      z.literal(""),
      z.null(),
    ])
    .nullish()
    .transform((v): string | null | undefined => (v === "" ? null : v)),
  kamId: z
    .number()
    .int()
    .positive(ClientsValidationMessages.KAM_REQUIRED),
  isActive: z.boolean().optional().default(true),
});

export type PlantLocationInput = z.infer<typeof plantLocationBodySchema>;

export const materialLocationBodySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, ClientsValidationMessages.MATERIAL_NAME_REQUIRED)
    .max(100),
  locationId: locationIdSchema,
  country: nullableStr(100),
  state: nullableStr(100),
  city: nullableStr(100),
  pincode: requiredPincodeSchema,
  isActive: z.boolean().optional().default(true),
});

export type MaterialLocationInput = z.infer<typeof materialLocationBodySchema>;

export const createClientSchema = z.object({
  companyName: z
    .string()
    .trim()
    .min(1, ClientsValidationMessages.COMPANY_NAME_REQUIRED)
    .max(100),
  isActive: z.boolean().optional(),
  companyInfo: companyInfoSchema,
  serviceFeeType: serviceFeeTypeSchema,
  serviceFeeValue: requiredServiceFeeValueSchema,
  auctionSettings: auctionSettingsSchema.optional(),
  plantLocations: z
    .array(plantLocationBodySchema)
    .min(1, ClientsValidationMessages.PLANT_LOCATION_REQUIRED),
  materialLocations: z.array(materialLocationBodySchema).optional(),
}).superRefine((data, ctx) => {
  if (!isValidServiceFeeValueForType(data.serviceFeeType, data.serviceFeeValue)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["serviceFeeValue"],
      message: serviceFeeValueIssueMessage(data.serviceFeeType),
    });
  }
});

export type CreateClientInput = z.infer<typeof createClientSchema>;

export const clientDocumentUploadFieldsSchema = z.object({
  documentTypeId: z.coerce
    .number({
      required_error: ClientsValidationMessages.DOCUMENT_TYPE_REQUIRED,
      invalid_type_error: ClientsValidationMessages.DOCUMENT_TYPE_REQUIRED,
    })
    .int()
    .positive(ClientsValidationMessages.DOCUMENT_TYPE_REQUIRED),
});

export type ClientDocumentUploadFields = z.infer<
  typeof clientDocumentUploadFieldsSchema
>;

export const additionalFieldBodySchema = z.object({
  label: z
    .string({
      required_error: ClientsValidationMessages.ADDITIONAL_FIELD_LABEL_REQUIRED,
    })
    .trim()
    .min(1, ClientsValidationMessages.ADDITIONAL_FIELD_LABEL_REQUIRED)
    .max(
      ADDITIONAL_FIELD_LABEL_MAX,
      ClientsValidationMessages.ADDITIONAL_FIELD_LABEL_MAX,
    ),
  scope: z.enum(ADDITIONAL_FIELD_SCOPES, {
    errorMap: () => ({
      message: ClientsValidationMessages.ADDITIONAL_FIELD_SCOPE_REQUIRED,
    }),
  }),
  dataType: z.enum(ADDITIONAL_FIELD_DATA_TYPES, {
    errorMap: () => ({
      message: ClientsValidationMessages.ADDITIONAL_FIELD_TYPE_REQUIRED,
    }),
  }),
  displayOrder: z
    .number()
    .int(ClientsValidationMessages.ADDITIONAL_FIELD_DISPLAY_ORDER_RANGE)
    .min(0, ClientsValidationMessages.ADDITIONAL_FIELD_DISPLAY_ORDER_RANGE)
    .max(9999, ClientsValidationMessages.ADDITIONAL_FIELD_DISPLAY_ORDER_RANGE)
    .default(0),
});

export type AdditionalFieldInput = z.infer<typeof additionalFieldBodySchema>;

export const additionalFieldStatusSchema = z.object({
  isActive: z.boolean(),
});

/** @deprecated Use clientDocumentUploadFieldsSchema (multipart uploads). */
export const clientDocumentUploadBodySchema = clientDocumentUploadFieldsSchema;
export type ClientDocumentUploadBody = ClientDocumentUploadFields;

