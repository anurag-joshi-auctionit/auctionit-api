import {
  ADDITIONAL_FIELD_DATA_TYPES,
  ADDITIONAL_FIELD_SCOPES,
  SERVICE_FEE_TYPES,
} from "@auctionit/messages/clients";
import { paginated } from "../common.js";
import { z } from "../zod.js";

// Mirrors ClientListResult / ClientDetail / MappedBiddersListResult / KamUserOption
// in services/clients.service.ts, ClientDocumentView / ClientDocumentTypeOption in
// services/client-documents.service.ts, ClientAdditionalField in
// services/client-additional-fields.service.ts and EntityUsersListResult in
// services/users.service.ts.

const ServiceFeeType = z
  .enum(SERVICE_FEE_TYPES)
  .openapi("ClientServiceFeeType");

export const ClientCounts = z
  .object({ total: z.number().int(), active: z.number().int(), inactive: z.number().int() })
  .openapi("ClientCounts");

export const ClientListItem = z
  .object({
    clientId: z.number().int(),
    companyName: z.string(),
    pan: z.string().nullable(),
    gstin: z.string().nullable(),
    country: z.string().nullable(),
    state: z.string().nullable(),
    city: z.string().nullable(),
    locationId: z.number().int().nullable(),
    serviceFeeType: ServiceFeeType,
    serviceFeeValue: z.number(),
    materials: z.array(z.number().int()).openapi({ description: "Material ids." }),
    plantLocationCount: z.number().int(),
    materialLocationCount: z.number().int(),
    isActive: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("ClientListItem");

export const ClientList = paginated(ClientListItem, { counts: ClientCounts }).openapi("ClientList");

export const ClientOptions = z
  .object({
    options: z.array(
      z.object({
        clientId: z.number().int(),
        companyName: z.string(),
        country: z.string().nullable(),
        auctionPrefix: z.string().nullable(),
      }),
    ),
  })
  .openapi("ClientOptions");

export const ClientKamUsers = z
  .object({
    users: z.array(
      z.object({ userId: z.number().int(), name: z.string(), emailId: z.string().nullable() }),
    ),
  })
  .openapi("ClientKamUsers");

export const ClientDocumentTypes = z
  .object({
    documentTypes: z.array(
      z.object({
        documentTypeId: z.number().int(),
        name: z.string(),
        fileNamePrefix: z.string(),
        allowedExtensions: z.array(z.string()).openapi({ description: "Per-type allowed extensions (T&C uses the auction-document rules)." }),
        maxBytes: z.number().int(),
      }),
    ),
    allowedExtensions: z.array(z.string()).openapi({ description: "Default extensions for non-T&C client documents." }),
  })
  .openapi("ClientDocumentTypes");

export const ClientPickerContext = z
  .object({
    regions: z.array(z.object({ regionId: z.number().int(), regionName: z.string().nullable() })).openapi({
      description: "Always empty (regions are not migrated yet).",
    }),
    plants: z.array(
      z.object({
        locationId: z.number().int().openapi({ description: "Plant location id." }),
        locationName: z.string().nullable(),
        city: z.string().nullable(),
      }),
    ),
  })
  .openapi("ClientPickerContext");

export const ClientIdResult = z.object({ clientId: z.number().int() }).openapi("ClientIdResult");

export const ClientNewId = z.object({ id: z.number().int() }).openapi("ClientNewId");

export const ClientPlantLocation = z
  .object({
    id: z.number().int(),
    name: z.string().nullable(),
    address: z.string().nullable(),
    country: z.string().nullable(),
    state: z.string().nullable(),
    city: z.string().nullable(),
    locationId: z.number().int().nullable(),
    pincode: z.string().nullable(),
    gstin: z.string().nullable(),
    pan: z.string().nullable(),
    pocName: z.string().nullable(),
    pocEmail: z.string().nullable().openapi({ description: "Comma-separated emails." }),
    pocPhone: z.string().nullable().openapi({ description: "Comma-separated phones." }),
    billingName: z.string().nullable(),
    billingEmailTo: z.string().nullable(),
    billingEmailCc: z.string().nullable(),
    gracePeriod: z.number().int().nullable(),
    orderNumber: z.string().nullable(),
    orderDate: z.string().nullable(),
    kamId: z.number().int().nullable(),
    kamName: z.string().nullable(),
    kamEmail: z.string().nullable(),
    isActive: z.boolean(),
  })
  .openapi("ClientPlantLocation");

export const ClientMaterialLocation = z
  .object({
    id: z.number().int(),
    name: z.string().nullable(),
    country: z.string().nullable(),
    state: z.string().nullable(),
    city: z.string().nullable(),
    locationId: z.number().int().nullable(),
    pincode: z.string().nullable(),
    isActive: z.boolean(),
  })
  .openapi("ClientMaterialLocation");

export const ClientDetail = z
  .object({
    clientId: z.number().int(),
    companyName: z.string(),
    isActive: z.boolean(),
    createdAt: z.string(),
    companyInfo: z.object({
      address: z.string().nullable(),
      locationId: z.number().int().nullable(),
      country: z.string().nullable(),
      state: z.string().nullable(),
      city: z.string().nullable(),
      pincode: z.string().nullable(),
      phone: z.string().nullable(),
      website: z.string().nullable(),
      email: z.string().nullable(),
      pan: z.string().nullable(),
      tan: z.string().nullable(),
      gstin: z.string().nullable(),
      materials: z.array(z.number().int()),
    }),
    auctionSettings: z.object({
      auctionPrefix: z.string().nullable(),
      serviceFeeType: ServiceFeeType,
      serviceFeeValue: z.number(),
      isLastBidExtension: z.boolean(),
      lastBidExtensionWindow: z.number().int(),
      lastBidExtensionInterval: z.number().int(),
      lastBidExtensionCountMax: z.number().int(),
      isStaggered: z.boolean(),
      staggerInterval: z.number().int(),
    }),
    regions: z.array(z.object({ regionId: z.number().int(), regionName: z.string().nullable(), isActive: z.boolean() })),
    plantLocations: z.array(ClientPlantLocation),
    materialLocations: z.array(ClientMaterialLocation),
    contacts: z.array(
      z.object({
        id: z.number().int(),
        name: z.string(),
        flag: z.string(),
        phone: z.string().nullable(),
        email: z.string().nullable(),
        isActive: z.boolean(),
      }),
    ),
    notifications: z.array(
      z.object({
        id: z.number().int(),
        notificationId: z.number().int(),
        notification: z.string(),
        minutes: z.number().int().nullable(),
        sendEmail: z.boolean().nullable(),
        sendSms: z.boolean().nullable(),
        isActive: z.boolean().nullable(),
      }),
    ),
    users: z.array(
      z.object({
        userId: z.number().int(),
        name: z.string(),
        emailId: z.string().nullable(),
        designation: z.string().nullable(),
        isActive: z.boolean(),
      }),
    ),
    canEditAuctionSettings: z
      .boolean()
      .openapi({ description: "False while any published auction of this client is live today (IST)." }),
  })
  .openapi("ClientDetail");

export const ClientDetailEnvelope = z.object({ client: ClientDetail }).openapi("ClientDetailEnvelope");

export const ClientMappedBidder = z
  .object({
    bidderId: z.number().int(),
    companyName: z.string(),
    contactPhone: z.string().nullable(),
    contactEmail: z.string().nullable(),
    auctionCount: z.number().int().openapi({ description: "Distinct auctions of this client the bidder is actively mapped to." }),
    lastAuctionDate: z.string().nullable(),
  })
  .openapi("ClientMappedBidder");

export const ClientMappedBidderList = paginated(ClientMappedBidder).openapi("ClientMappedBidderList");

export const ClientDocument = z
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
  .openapi("ClientDocument");

export const ClientDocumentList = paginated(ClientDocument).openapi("ClientDocumentList");

export const ClientDocumentEnvelope = z.object({ document: ClientDocument }).openapi("ClientDocumentEnvelope");

export const ClientAdditionalField = z
  .object({
    id: z.number().int(),
    clientId: z.number().int(),
    label: z.string(),
    scope: z.enum(ADDITIONAL_FIELD_SCOPES),
    dataType: z.enum(ADDITIONAL_FIELD_DATA_TYPES),
    displayOrder: z.number().int(),
    isActive: z.boolean(),
    hasValues: z.boolean().openapi({ description: "True once any auction/lot stores a value; scope and data type are then locked." }),
  })
  .openapi("ClientAdditionalField");

export const ClientAdditionalFieldList = z
  .object({ fields: z.array(ClientAdditionalField) })
  .openapi("ClientAdditionalFieldList");

export const ClientUser = z
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
  .openapi("ClientUser");

export const ClientUserList = paginated(ClientUser).openapi("ClientUserList");

export const ClientUserCreated = z.object({ userId: z.number().int() }).openapi("ClientUserCreated");

/** `{ error, code }` when emailing a temporary password fails. */
export const ClientUserCredentialsErrorBody = z
  .object({ error: z.string(), code: z.enum(["OTP_MISSING_EMAIL", "OTP_DELIVERY_FAILED"]) })
  .openapi("ClientUserCredentialsErrorBody");
