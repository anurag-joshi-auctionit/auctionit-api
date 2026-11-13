import { defineRelations } from "drizzle-orm/relations";
import { auctionLotBidderMaps } from "./auction-lot-bidder-maps.js";
import { auctionDocumentTypes } from "./auction-document-types.js";
import { auctionDocuments } from "./auction-documents.js";
import { auctionLotConfirmationDocuments } from "./auction-lot-confirmation-documents.js";
import { auctionCatalogueNotifications } from "./auction-catalogue-notifications.js";
import { auctionLotEmdRanges } from "./auction-lot-emd-ranges.js";
import { auctionLotImportStagingSessions } from "./auction-lot-import-staging.js";
import { auctionLotItems, auctionLots } from "./auction-lots.js";
import { auctionLotWatchlist } from "./auction-lot-watchlist.js";
import { auctionLotExtensions } from "./auction-lot-extensions.js";
import { auctionTncAcceptances } from "./auction-tnc-acceptances.js";
import { auctionBids } from "./auction-bids.js";
import { auctionSealedBids } from "./auction-sealed-bids.js";
import { auctionBidLogs } from "./auction-bid-logs.js";
import { auctionProxyBids } from "./auction-proxy-bids.js";
import { auctions } from "./auctions.js";
import { benchmarkLocations } from "./benchmark-locations.js";
import { benchmarkMaterialLocations } from "./benchmark-material-locations.js";
import { benchmarkMaterials } from "./benchmark-materials.js";
import { benchmarkPrices } from "./benchmark-prices.js";
import { bidderDocumentTypes } from "./bidder-document-types.js";
import { bidderDocumentLogs } from "./bidder-document-logs.js";
import { bidderBlockLogs } from "./bidder-blocks.js";
import { bidderExemptionLogs } from "./bidder-exemptions.js";
import { bidderBankAccounts } from "./bidder-bank-accounts.js";
import { bidderBankAccountLogs } from "./bidder-bank-account-logs.js";
import { clientDocumentTypes } from "./client-document-types.js";
import { clientDocumentLogs } from "./client-document-logs.js";
import { clientAdditionalFields, auctionAdditionalFieldValues } from "./additional-fields.js";
import { additionalFieldsImportJobs } from "./additional-fields-import-jobs.js";
import { bidders } from "./bidders.js";
import { bidderRegistrations } from "./bidder-registrations.js";
import { clients } from "./clients.js";
import { userClients } from "./user-clients.js";
import { files } from "./files.js";
import { items } from "./items.js";
import { locations } from "./locations.js";
import { materials } from "./materials.js";
import { materialLocations } from "./material-locations.js";
import { plantLocations } from "./plant-locations.js";
import { roles } from "./roles.js";
import { permissions, rolePermissions } from "./permissions.js";
import { emdTransactions } from "./emd-transactions.js";
import { emdRefunds } from "./emd-refunds.js";
import { emdForfeitureDispositions } from "./emd-forfeiture-dispositions.js";
import { emdForfeitures } from "./emd-forfeitures.js";
import { emdTransfers } from "./emd-transfers.js";
import { emdImportStagingSessions } from "./emd-import-staging.js";
import { emdSettlementJobs } from "./emd-settlement-jobs.js";
import { emdWinningLotReleases } from "./emd-winning-lot-releases.js";
import { emdRangeHolds } from "./emd-range-holds.js";
import { subscriptionTypes } from "./subscription-types.js";
import { paymentTypes } from "./payment-types.js";
import { subscriptions } from "./subscriptions.js";
import { subscriptionDocumentTypes } from "./subscription-document-types.js";
import { subscriptionDocuments } from "./subscription-documents.js";
import { subscriptionPaymentRequests } from "./subscription-payment-requests.js";
import {
  liftingClientDispositions,
  liftingBidderDispositions,
} from "./lifting-dispositions.js";
import { liftingClientLogs } from "./lifting-client-log.js";
import { liftingEngagementLogs } from "./lifting-engagement-log.js";
import { serviceInvoices } from "./service-invoices.js";
import { serviceInvoiceDocumentTypes } from "./service-invoice-document-types.js";
import { serviceInvoiceDocuments } from "./service-invoice-documents.js";
import { serviceInvoicePaymentLogs } from "./service-invoice-payment-logs.js";
import { notificationTypes } from "./notification-types.js";
import { notificationEmailLogs } from "./notification-email-logs.js";
import { users } from "./users.js";
import { uoms } from "./uoms.js";

const schema = {
  auctionLotBidderMaps,
  auctionDocumentTypes,
  auctionDocuments,
  auctionLotConfirmationDocuments,
  auctionCatalogueNotifications,
  auctionLotEmdRanges,
  auctionLotImportStagingSessions,
  auctionLotItems,
  auctionLots,
  auctionLotWatchlist,
  auctionLotExtensions,
  auctionTncAcceptances,
  auctionBids,
  auctionSealedBids,
  auctionBidLogs,
  auctionProxyBids,
  auctions,
  benchmarkLocations,
  benchmarkMaterialLocations,
  benchmarkMaterials,
  benchmarkPrices,
  bidderDocumentTypes,
  bidderDocumentLogs,
  bidderBlockLogs,
  bidderExemptionLogs,
  bidderBankAccounts,
  bidderBankAccountLogs,
  clientDocumentTypes,
  clientDocumentLogs,
  clientAdditionalFields,
  auctionAdditionalFieldValues,
  additionalFieldsImportJobs,
  bidders,
  bidderRegistrations,
  clients,
  userClients,
  files,
  items,
  locations,
  materials,
  materialLocations,
  plantLocations,
  roles,
  permissions,
  rolePermissions,
  emdTransactions,
  emdRefunds,
  emdForfeitureDispositions,
  emdForfeitures,
  emdTransfers,
  emdImportStagingSessions,
  emdSettlementJobs,
  emdWinningLotReleases,
  emdRangeHolds,
  subscriptionTypes,
  paymentTypes,
  subscriptions,
  subscriptionDocumentTypes,
  subscriptionDocuments,
  subscriptionPaymentRequests,
  liftingClientDispositions,
  liftingBidderDispositions,
  liftingClientLogs,
  liftingEngagementLogs,
  serviceInvoices,
  serviceInvoiceDocumentTypes,
  serviceInvoiceDocuments,
  serviceInvoicePaymentLogs,
  notificationTypes,
  notificationEmailLogs,
  users,
  uoms,
};

export const relations = defineRelations(schema, (r) => ({
  auctionLots: {
    auction: r.one.auctions({
      from: r.auctionLots.auctionId,
      to: r.auctions.id,
    }),
    client: r.one.clients({
      from: r.auctionLots.clientId,
      to: r.clients.id,
    }),
    uom: r.one.uoms({
      from: r.auctionLots.uomId,
      to: r.uoms.id,
    }),
    reviewedByUser: r.one.users({
      from: r.auctionLots.reviewedBy,
      to: r.users.id,
    }),
    winnerUser: r.one.users({
      from: r.auctionLots.winnerUserId,
      to: r.users.id,
    }),
    winnerBidder: r.one.bidders({
      from: r.auctionLots.winnerBidderId,
      to: r.bidders.id,
    }),
    items: r.many.auctionLotItems(),
  },
  auctionLotItems: {
    lot: r.one.auctionLots({
      from: r.auctionLotItems.lotId,
      to: r.auctionLots.id,
    }),
    item: r.one.items({
      from: r.auctionLotItems.itemId,
      to: r.items.id,
    }),
    benchmarkMaterialLocation: r.one.benchmarkMaterialLocations({
      from: r.auctionLotItems.benchmarkMaterialLocationId,
      to: r.benchmarkMaterialLocations.id,
    }),
  },
  auctionLotBidderMaps: {
    auction: r.one.auctions({
      from: r.auctionLotBidderMaps.auctionId,
      to: r.auctions.id,
    }),
    client: r.one.clients({
      from: r.auctionLotBidderMaps.clientId,
      to: r.clients.id,
    }),
    bidder: r.one.bidders({
      from: r.auctionLotBidderMaps.bidderId,
      to: r.bidders.id,
    }),
    lot: r.one.auctionLots({
      from: r.auctionLotBidderMaps.lotId,
      to: r.auctionLots.id,
    }),
  },
  auctionLotEmdRanges: {
    auction: r.one.auctions({
      from: r.auctionLotEmdRanges.auctionId,
      to: r.auctions.id,
    }),
    createdByUser: r.one.users({
      from: r.auctionLotEmdRanges.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.auctionLotEmdRanges.updatedBy,
      to: r.users.id,
    }),
  },
  auctionLotImportStagingSessions: {
    auction: r.one.auctions({
      from: r.auctionLotImportStagingSessions.auctionId,
      to: r.auctions.id,
    }),
    client: r.one.clients({
      from: r.auctionLotImportStagingSessions.clientId,
      to: r.clients.id,
    }),
    createdByUser: r.one.users({
      from: r.auctionLotImportStagingSessions.createdBy,
      to: r.users.id,
    }),
  },
  auctionLotWatchlist: {
    bidder: r.one.bidders({
      from: r.auctionLotWatchlist.bidderId,
      to: r.bidders.id,
    }),
    lot: r.one.auctionLots({
      from: r.auctionLotWatchlist.lotId,
      to: r.auctionLots.id,
    }),
  },
  auctionLotExtensions: {
    auction: r.one.auctions({
      from: r.auctionLotExtensions.auctionId,
      to: r.auctions.id,
    }),
    lot: r.one.auctionLots({
      from: r.auctionLotExtensions.lotId,
      to: r.auctionLots.id,
    }),
    triggeredByBidder: r.one.bidders({
      from: r.auctionLotExtensions.triggeredByBidderId,
      to: r.bidders.id,
    }),
  },
  auctionTncAcceptances: {
    auction: r.one.auctions({
      from: r.auctionTncAcceptances.auctionId,
      to: r.auctions.id,
    }),
    bidder: r.one.bidders({
      from: r.auctionTncAcceptances.bidderId,
      to: r.bidders.id,
    }),
    acceptedByUser: r.one.users({
      from: r.auctionTncAcceptances.acceptedByUserId,
      to: r.users.id,
    }),
  },
  auctionBids: {
    auction: r.one.auctions({
      from: r.auctionBids.auctionId,
      to: r.auctions.id,
    }),
    lot: r.one.auctionLots({
      from: r.auctionBids.lotId,
      to: r.auctionLots.id,
    }),
    bidder: r.one.bidders({
      from: r.auctionBids.bidderId,
      to: r.bidders.id,
    }),
    user: r.one.users({
      from: r.auctionBids.userId,
      to: r.users.id,
    }),
  },
  auctionSealedBids: {
    auction: r.one.auctions({
      from: r.auctionSealedBids.auctionId,
      to: r.auctions.id,
    }),
    lot: r.one.auctionLots({
      from: r.auctionSealedBids.lotId,
      to: r.auctionLots.id,
    }),
    client: r.one.clients({
      from: r.auctionSealedBids.clientId,
      to: r.clients.id,
    }),
    bidder: r.one.bidders({
      from: r.auctionSealedBids.bidderId,
      to: r.bidders.id,
    }),
    user: r.one.users({
      from: r.auctionSealedBids.userId,
      to: r.users.id,
    }),
    removedByUser: r.one.users({
      from: r.auctionSealedBids.removedBy,
      to: r.users.id,
    }),
  },
  auctionBidLogs: {
    auction: r.one.auctions({
      from: r.auctionBidLogs.auctionId,
      to: r.auctions.id,
    }),
    lot: r.one.auctionLots({
      from: r.auctionBidLogs.lotId,
      to: r.auctionLots.id,
    }),
    bidder: r.one.bidders({
      from: r.auctionBidLogs.bidderId,
      to: r.bidders.id,
    }),
    user: r.one.users({
      from: r.auctionBidLogs.userId,
      to: r.users.id,
    }),
    removedByUser: r.one.users({
      from: r.auctionBidLogs.removedBy,
      to: r.users.id,
    }),
  },
  auctionProxyBids: {
    auction: r.one.auctions({
      from: r.auctionProxyBids.auctionId,
      to: r.auctions.id,
    }),
    lot: r.one.auctionLots({
      from: r.auctionProxyBids.lotId,
      to: r.auctionLots.id,
    }),
    bidder: r.one.bidders({
      from: r.auctionProxyBids.bidderId,
      to: r.bidders.id,
    }),
    user: r.one.users({
      from: r.auctionProxyBids.userId,
      to: r.users.id,
    }),
  },
  auctionDocumentTypes: {
    createdByUser: r.one.users({
      from: r.auctionDocumentTypes.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.auctionDocumentTypes.updatedBy,
      to: r.users.id,
    }),
  },
  auctionDocuments: {
    auction: r.one.auctions({
      from: r.auctionDocuments.auctionId,
      to: r.auctions.id,
    }),
    documentType: r.one.auctionDocumentTypes({
      from: r.auctionDocuments.documentTypeId,
      to: r.auctionDocumentTypes.id,
    }),
  },
  auctionLotConfirmationDocuments: {
    auction: r.one.auctions({
      from: r.auctionLotConfirmationDocuments.auctionId,
      to: r.auctions.id,
    }),
    bidder: r.one.bidders({
      from: r.auctionLotConfirmationDocuments.bidderId,
      to: r.bidders.id,
    }),
    createdByUser: r.one.users({
      from: r.auctionLotConfirmationDocuments.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.auctionLotConfirmationDocuments.updatedBy,
      to: r.users.id,
    }),
    emailSentByUser: r.one.users({
      from: r.auctionLotConfirmationDocuments.emailSentBy,
      to: r.users.id,
    }),
  },
  auctionCatalogueNotifications: {
    auction: r.one.auctions({
      from: r.auctionCatalogueNotifications.auctionId,
      to: r.auctions.id,
    }),
    client: r.one.clients({
      from: r.auctionCatalogueNotifications.clientId,
      to: r.clients.id,
    }),
    sentByUser: r.one.users({
      from: r.auctionCatalogueNotifications.sentBy,
      to: r.users.id,
    }),
  },
  auctions: {
    client: r.one.clients({
      from: r.auctions.clientId,
      to: r.clients.id,
    }),
    createdByUser: r.one.users({
      from: r.auctions.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.auctions.updatedBy,
      to: r.users.id,
    }),
    catalogueNotifications: r.many.auctionCatalogueNotifications(),
  },
  benchmarkMaterialLocations: {
    prices: r.many.benchmarkPrices(),
    material: r.one.benchmarkMaterials({
      from: r.benchmarkMaterialLocations.materialId,
      to: r.benchmarkMaterials.id,
    }),
    location: r.one.benchmarkLocations({
      from: r.benchmarkMaterialLocations.locationId,
      to: r.benchmarkLocations.id,
    }),
    createdByUser: r.one.users({
      from: r.benchmarkMaterialLocations.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.benchmarkMaterialLocations.updatedBy,
      to: r.users.id,
    }),
  },
  benchmarkMaterials: {
    combos: r.many.benchmarkMaterialLocations(),
    createdByUser: r.one.users({
      from: r.benchmarkMaterials.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.benchmarkMaterials.updatedBy,
      to: r.users.id,
    }),
  },
  benchmarkLocations: {
    combos: r.many.benchmarkMaterialLocations(),
    createdByUser: r.one.users({
      from: r.benchmarkLocations.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.benchmarkLocations.updatedBy,
      to: r.users.id,
    }),
  },
  benchmarkPrices: {
    combo: r.one.benchmarkMaterialLocations({
      from: r.benchmarkPrices.benchmarkMaterialLocationId,
      to: r.benchmarkMaterialLocations.id,
    }),
    createdByUser: r.one.users({
      from: r.benchmarkPrices.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.benchmarkPrices.updatedBy,
      to: r.users.id,
    }),
  },
  bidders: {
    location: r.one.locations({
      from: r.bidders.locationId,
      to: r.locations.id,
    }),
    registrations: r.many.bidderRegistrations(),
    documentLogs: r.many.bidderDocumentLogs(),
    blockLogs: r.many.bidderBlockLogs(),
    exemptionLogs: r.many.bidderExemptionLogs(),
    bankAccounts: r.many.bidderBankAccounts(),
    bankAccountLogs: r.many.bidderBankAccountLogs(),
  },
  bidderDocumentTypes: {
    documentLogs: r.many.bidderDocumentLogs(),
    createdByUser: r.one.users({
      from: r.bidderDocumentTypes.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.bidderDocumentTypes.updatedBy,
      to: r.users.id,
    }),
  },
  bidderDocumentLogs: {
    bidder: r.one.bidders({
      from: r.bidderDocumentLogs.bidderId,
      to: r.bidders.id,
    }),
    documentType: r.one.bidderDocumentTypes({
      from: r.bidderDocumentLogs.documentTypeId,
      to: r.bidderDocumentTypes.id,
    }),
    createdByUser: r.one.users({
      from: r.bidderDocumentLogs.createdBy,
      to: r.users.id,
    }),
  },
  bidderBlockLogs: {
    client: r.one.clients({
      from: r.bidderBlockLogs.clientId,
      to: r.clients.id,
    }),
    bidder: r.one.bidders({
      from: r.bidderBlockLogs.bidderId,
      to: r.bidders.id,
    }),
    createdByUser: r.one.users({
      from: r.bidderBlockLogs.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.bidderBlockLogs.updatedBy,
      to: r.users.id,
    }),
  },
  bidderExemptionLogs: {
    client: r.one.clients({
      from: r.bidderExemptionLogs.clientId,
      to: r.clients.id,
    }),
    bidder: r.one.bidders({
      from: r.bidderExemptionLogs.bidderId,
      to: r.bidders.id,
    }),
    createdByUser: r.one.users({
      from: r.bidderExemptionLogs.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.bidderExemptionLogs.updatedBy,
      to: r.users.id,
    }),
  },
  bidderBankAccounts: {
    bidder: r.one.bidders({
      from: r.bidderBankAccounts.bidderId,
      to: r.bidders.id,
    }),
    createdByUser: r.one.users({
      from: r.bidderBankAccounts.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.bidderBankAccounts.updatedBy,
      to: r.users.id,
    }),
    reviewedByUser: r.one.users({
      from: r.bidderBankAccounts.reviewedBy,
      to: r.users.id,
    }),
  },
  bidderBankAccountLogs: {
    bidder: r.one.bidders({
      from: r.bidderBankAccountLogs.bidderId,
      to: r.bidders.id,
    }),
    requestedByUser: r.one.users({
      from: r.bidderBankAccountLogs.requestedBy,
      to: r.users.id,
    }),
    reviewedByUser: r.one.users({
      from: r.bidderBankAccountLogs.reviewedBy,
      to: r.users.id,
    }),
  },
  bidderRegistrations: {
    bidder: r.one.bidders({
      from: r.bidderRegistrations.bidderId,
      to: r.bidders.id,
    }),
    paymentUpdatedByUser: r.one.users({
      from: r.bidderRegistrations.paymentUpdatedBy,
      to: r.users.id,
    }),
    createdByUser: r.one.users({
      from: r.bidderRegistrations.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.bidderRegistrations.updatedBy,
      to: r.users.id,
    }),
  },
  clients: {
    location: r.one.locations({
      from: r.clients.locationId,
      to: r.locations.id,
    }),
    plantLocations: r.many.plantLocations(),
    materialLocations: r.many.materialLocations(),
    items: r.many.items(),
    auctions: r.many.auctions(),
    serviceInvoices: r.many.serviceInvoices(),
    userClients: r.many.userClients(),
    documentLogs: r.many.clientDocumentLogs(),
    additionalFields: r.many.clientAdditionalFields(),
  },
  clientAdditionalFields: {
    client: r.one.clients({
      from: r.clientAdditionalFields.clientId,
      to: r.clients.id,
    }),
    createdByUser: r.one.users({
      from: r.clientAdditionalFields.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.clientAdditionalFields.updatedBy,
      to: r.users.id,
    }),
    values: r.many.auctionAdditionalFieldValues(),
  },
  auctionAdditionalFieldValues: {
    auction: r.one.auctions({
      from: r.auctionAdditionalFieldValues.auctionId,
      to: r.auctions.id,
    }),
    lot: r.one.auctionLots({
      from: r.auctionAdditionalFieldValues.lotId,
      to: r.auctionLots.id,
    }),
    field: r.one.clientAdditionalFields({
      from: r.auctionAdditionalFieldValues.fieldId,
      to: r.clientAdditionalFields.id,
    }),
    createdByUser: r.one.users({
      from: r.auctionAdditionalFieldValues.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.auctionAdditionalFieldValues.updatedBy,
      to: r.users.id,
    }),
  },
  additionalFieldsImportJobs: {
    auction: r.one.auctions({
      from: r.additionalFieldsImportJobs.auctionId,
      to: r.auctions.id,
    }),
    createdByUser: r.one.users({
      from: r.additionalFieldsImportJobs.createdBy,
      to: r.users.id,
    }),
  },
  userClients: {
    user: r.one.users({
      from: r.userClients.userId,
      to: r.users.id,
    }),
    client: r.one.clients({
      from: r.userClients.clientId,
      to: r.clients.id,
    }),
  },
  clientDocumentTypes: {
    documentLogs: r.many.clientDocumentLogs(),
    createdByUser: r.one.users({
      from: r.clientDocumentTypes.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.clientDocumentTypes.updatedBy,
      to: r.users.id,
    }),
  },
  clientDocumentLogs: {
    client: r.one.clients({
      from: r.clientDocumentLogs.clientId,
      to: r.clients.id,
    }),
    documentType: r.one.clientDocumentTypes({
      from: r.clientDocumentLogs.documentTypeId,
      to: r.clientDocumentTypes.id,
    }),
    createdByUser: r.one.users({
      from: r.clientDocumentLogs.createdBy,
      to: r.users.id,
    }),
  },
  files: {
    uploadedByUser: r.one.users({
      from: r.files.uploadedBy,
      to: r.users.id,
    }),
  },
  items: {
    client: r.one.clients({
      from: r.items.clientId,
      to: r.clients.id,
    }),
    material: r.one.materials({
      from: r.items.materialId,
      to: r.materials.id,
    }),
    uom: r.one.uoms({
      from: r.items.uomId,
      to: r.uoms.id,
    }),
    createdByUser: r.one.users({
      from: r.items.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.items.updatedBy,
      to: r.users.id,
    }),
  },
  locations: {
    clients: r.many.clients(),
    plantLocations: r.many.plantLocations(),
    materialLocations: r.many.materialLocations(),
    bidders: r.many.bidders(),
  },
  materialLocations: {
    client: r.one.clients({
      from: r.materialLocations.clientId,
      to: r.clients.id,
    }),
    location: r.one.locations({
      from: r.materialLocations.locationId,
      to: r.locations.id,
    }),
  },
  plantLocations: {
    client: r.one.clients({
      from: r.plantLocations.clientId,
      to: r.clients.id,
    }),
    location: r.one.locations({
      from: r.plantLocations.locationId,
      to: r.locations.id,
    }),
    kam: r.one.users({
      from: r.plantLocations.kamId,
      to: r.users.id,
    }),
    serviceInvoices: r.many.serviceInvoices(),
  },
  emdTransactions: {
    bidder: r.one.bidders({
      from: r.emdTransactions.bidderId,
      to: r.bidders.id,
    }),
    auction: r.one.auctions({
      from: r.emdTransactions.auctionId,
      to: r.auctions.id,
    }),
    emdRange: r.one.auctionLotEmdRanges({
      from: r.emdTransactions.emdRangeId,
      to: r.auctionLotEmdRanges.id,
    }),
    refund: r.one.emdRefunds({
      from: r.emdTransactions.refundId,
      to: r.emdRefunds.id,
    }),
    forfeiture: r.one.emdForfeitures({
      from: r.emdTransactions.forfeitureId,
      to: r.emdForfeitures.id,
    }),
    transfer: r.one.emdTransfers({
      from: r.emdTransactions.transferId,
      to: r.emdTransfers.id,
    }),
    paymentType: r.one.paymentTypes({
      from: r.emdTransactions.paymentTypeId,
      to: r.paymentTypes.id,
    }),
    createdByUser: r.one.users({
      from: r.emdTransactions.createdBy,
      to: r.users.id,
    }),
  },
  emdRefunds: {
    bidder: r.one.bidders({
      from: r.emdRefunds.bidderId,
      to: r.bidders.id,
    }),
    requestedByUser: r.one.users({
      from: r.emdRefunds.requestedBy,
      to: r.users.id,
    }),
    reviewedByUser: r.one.users({
      from: r.emdRefunds.reviewedBy,
      to: r.users.id,
    }),
    verifiedByUser: r.one.users({
      from: r.emdRefunds.verifiedBy,
      to: r.users.id,
    }),
    paidByUser: r.one.users({
      from: r.emdRefunds.paidBy,
      to: r.users.id,
    }),
    cancelledByUser: r.one.users({
      from: r.emdRefunds.cancelledBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.emdRefunds.updatedBy,
      to: r.users.id,
    }),
  },
  emdForfeitureDispositions: {
    createdByUser: r.one.users({
      from: r.emdForfeitureDispositions.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.emdForfeitureDispositions.updatedBy,
      to: r.users.id,
    }),
  },
  emdForfeitures: {
    auction: r.one.auctions({
      from: r.emdForfeitures.auctionId,
      to: r.auctions.id,
    }),
    bidder: r.one.bidders({
      from: r.emdForfeitures.bidderId,
      to: r.bidders.id,
    }),
    emdRange: r.one.auctionLotEmdRanges({
      from: r.emdForfeitures.emdRangeId,
      to: r.auctionLotEmdRanges.id,
    }),
    disposition: r.one.emdForfeitureDispositions({
      from: r.emdForfeitures.dispositionId,
      to: r.emdForfeitureDispositions.id,
    }),
    attachmentFile: r.one.files({
      from: r.emdForfeitures.attachmentFileId,
      to: r.files.id,
    }),
    requestedByUser: r.one.users({
      from: r.emdForfeitures.requestedBy,
      to: r.users.id,
    }),
    reviewedByUser: r.one.users({
      from: r.emdForfeitures.reviewedBy,
      to: r.users.id,
    }),
    paidToClientByUser: r.one.users({
      from: r.emdForfeitures.paidToClientBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.emdForfeitures.updatedBy,
      to: r.users.id,
    }),
  },
  emdTransfers: {
    fromBidder: r.one.bidders({
      from: r.emdTransfers.fromBidderId,
      to: r.bidders.id,
    }),
    toBidder: r.one.bidders({
      from: r.emdTransfers.toBidderId,
      to: r.bidders.id,
    }),
    requestedByUser: r.one.users({
      from: r.emdTransfers.requestedBy,
      to: r.users.id,
    }),
    reviewedByUser: r.one.users({
      from: r.emdTransfers.reviewedBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.emdTransfers.updatedBy,
      to: r.users.id,
    }),
  },
  emdImportStagingSessions: {
    createdByUser: r.one.users({
      from: r.emdImportStagingSessions.createdBy,
      to: r.users.id,
    }),
  },
  emdSettlementJobs: {
    auction: r.one.auctions({
      from: r.emdSettlementJobs.auctionId,
      to: r.auctions.id,
    }),
    lot: r.one.auctionLots({
      from: r.emdSettlementJobs.lotId,
      to: r.auctionLots.id,
    }),
    createdByUser: r.one.users({
      from: r.emdSettlementJobs.createdBy,
      to: r.users.id,
    }),
  },
  emdWinningLotReleases: {
    auction: r.one.auctions({
      from: r.emdWinningLotReleases.auctionId,
      to: r.auctions.id,
    }),
    bidder: r.one.bidders({
      from: r.emdWinningLotReleases.bidderId,
      to: r.bidders.id,
    }),
    lot: r.one.auctionLots({
      from: r.emdWinningLotReleases.lotId,
      to: r.auctionLots.id,
    }),
    emdRange: r.one.auctionLotEmdRanges({
      from: r.emdWinningLotReleases.emdRangeId,
      to: r.auctionLotEmdRanges.id,
    }),
    transaction: r.one.emdTransactions({
      from: r.emdWinningLotReleases.transactionId,
      to: r.emdTransactions.id,
    }),
    createdByUser: r.one.users({
      from: r.emdWinningLotReleases.createdBy,
      to: r.users.id,
    }),
  },
  emdRangeHolds: {
    auction: r.one.auctions({
      from: r.emdRangeHolds.auctionId,
      to: r.auctions.id,
    }),
    bidder: r.one.bidders({
      from: r.emdRangeHolds.bidderId,
      to: r.bidders.id,
    }),
    emdRange: r.one.auctionLotEmdRanges({
      from: r.emdRangeHolds.emdRangeId,
      to: r.auctionLotEmdRanges.id,
    }),
  },
  subscriptionTypes: {
    createdByUser: r.one.users({
      from: r.subscriptionTypes.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.subscriptionTypes.updatedBy,
      to: r.users.id,
    }),
  },
  paymentTypes: {
    createdByUser: r.one.users({
      from: r.paymentTypes.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.paymentTypes.updatedBy,
      to: r.users.id,
    }),
  },
  subscriptions: {
    bidder: r.one.bidders({
      from: r.subscriptions.bidderId,
      to: r.bidders.id,
    }),
    subscriptionType: r.one.subscriptionTypes({
      from: r.subscriptions.subscriptionTypeId,
      to: r.subscriptionTypes.id,
    }),
    paymentType: r.one.paymentTypes({
      from: r.subscriptions.paymentMode,
      to: r.paymentTypes.id,
    }),
    invoiceRequestedByUser: r.one.users({
      from: r.subscriptions.invoiceRequestedBy,
      to: r.users.id,
    }),
    invoiceGeneratedByUser: r.one.users({
      from: r.subscriptions.invoiceGeneratedBy,
      to: r.users.id,
    }),
    invoiceRecheckedByUser: r.one.users({
      from: r.subscriptions.invoiceRecheckedBy,
      to: r.users.id,
    }),
    invoiceCancelledByUser: r.one.users({
      from: r.subscriptions.invoiceCancelledBy,
      to: r.users.id,
    }),
    emailSentByUser: r.one.users({
      from: r.subscriptions.emailSentBy,
      to: r.users.id,
    }),
    createdByUser: r.one.users({
      from: r.subscriptions.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.subscriptions.updatedBy,
      to: r.users.id,
    }),
    documents: r.many.subscriptionDocuments(),
    paymentRequests: r.many.subscriptionPaymentRequests(),
  },
  subscriptionDocumentTypes: {
    createdByUser: r.one.users({
      from: r.subscriptionDocumentTypes.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.subscriptionDocumentTypes.updatedBy,
      to: r.users.id,
    }),
    documents: r.many.subscriptionDocuments(),
  },
  subscriptionDocuments: {
    subscription: r.one.subscriptions({
      from: r.subscriptionDocuments.subscriptionId,
      to: r.subscriptions.id,
    }),
    documentType: r.one.subscriptionDocumentTypes({
      from: r.subscriptionDocuments.documentTypeId,
      to: r.subscriptionDocumentTypes.id,
    }),
    createdByUser: r.one.users({
      from: r.subscriptionDocuments.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.subscriptionDocuments.updatedBy,
      to: r.users.id,
    }),
  },
  subscriptionPaymentRequests: {
    bidder: r.one.bidders({
      from: r.subscriptionPaymentRequests.bidderId,
      to: r.bidders.id,
    }),
    subscriptionType: r.one.subscriptionTypes({
      from: r.subscriptionPaymentRequests.subscriptionTypeId,
      to: r.subscriptionTypes.id,
    }),
    subscription: r.one.subscriptions({
      from: r.subscriptionPaymentRequests.subscriptionId,
      to: r.subscriptions.id,
    }),
    initiatedByUser: r.one.users({
      from: r.subscriptionPaymentRequests.initiatedByUserId,
      to: r.users.id,
    }),
  },
  liftingClientDispositions: {
    createdByUser: r.one.users({
      from: r.liftingClientDispositions.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.liftingClientDispositions.updatedBy,
      to: r.users.id,
    }),
    logs: r.many.liftingClientLogs(),
  },
  liftingBidderDispositions: {
    createdByUser: r.one.users({
      from: r.liftingBidderDispositions.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.liftingBidderDispositions.updatedBy,
      to: r.users.id,
    }),
    engagementLogs: r.many.liftingEngagementLogs(),
  },
  liftingClientLogs: {
    client: r.one.clients({
      from: r.liftingClientLogs.clientId,
      to: r.clients.id,
    }),
    auction: r.one.auctions({
      from: r.liftingClientLogs.auctionId,
      to: r.auctions.id,
    }),
    lot: r.one.auctionLots({
      from: r.liftingClientLogs.lotId,
      to: r.auctionLots.id,
    }),
    item: r.one.items({
      from: r.liftingClientLogs.itemId,
      to: r.items.id,
    }),
    disposition: r.one.liftingClientDispositions({
      from: r.liftingClientLogs.liftingStatus,
      to: r.liftingClientDispositions.id,
    }),
    createdByUser: r.one.users({
      from: r.liftingClientLogs.createdBy,
      to: r.users.id,
    }),
  },
  liftingEngagementLogs: {
    client: r.one.clients({
      from: r.liftingEngagementLogs.clientId,
      to: r.clients.id,
    }),
    lot: r.one.auctionLots({
      from: r.liftingEngagementLogs.lotId,
      to: r.auctionLots.id,
    }),
    disposition: r.one.liftingBidderDispositions({
      from: r.liftingEngagementLogs.dispositionId,
      to: r.liftingBidderDispositions.id,
    }),
    loggedByUser: r.one.users({
      from: r.liftingEngagementLogs.loggedByUserId,
      to: r.users.id,
    }),
  },
  serviceInvoices: {
    client: r.one.clients({
      from: r.serviceInvoices.clientId,
      to: r.clients.id,
    }),
    plantLocation: r.one.plantLocations({
      from: r.serviceInvoices.plantLocationId,
      to: r.plantLocations.id,
    }),
    documents: r.many.serviceInvoiceDocuments(),
    paymentLogs: r.many.serviceInvoicePaymentLogs(),
    createdByUser: r.one.users({
      from: r.serviceInvoices.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.serviceInvoices.updatedBy,
      to: r.users.id,
    }),
  },
  serviceInvoiceDocumentTypes: {
    documents: r.many.serviceInvoiceDocuments(),
    createdByUser: r.one.users({
      from: r.serviceInvoiceDocumentTypes.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.serviceInvoiceDocumentTypes.updatedBy,
      to: r.users.id,
    }),
  },
  serviceInvoiceDocuments: {
    serviceInvoice: r.one.serviceInvoices({
      from: r.serviceInvoiceDocuments.serviceInvoiceId,
      to: r.serviceInvoices.id,
    }),
    documentType: r.one.serviceInvoiceDocumentTypes({
      from: r.serviceInvoiceDocuments.documentTypeId,
      to: r.serviceInvoiceDocumentTypes.id,
    }),
    createdByUser: r.one.users({
      from: r.serviceInvoiceDocuments.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.serviceInvoiceDocuments.updatedBy,
      to: r.users.id,
    }),
  },
  serviceInvoicePaymentLogs: {
    serviceInvoice: r.one.serviceInvoices({
      from: r.serviceInvoicePaymentLogs.serviceInvoiceId,
      to: r.serviceInvoices.id,
    }),
    createdByUser: r.one.users({
      from: r.serviceInvoicePaymentLogs.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.serviceInvoicePaymentLogs.updatedBy,
      to: r.users.id,
    }),
  },
  notificationTypes: {
    createdByUser: r.one.users({
      from: r.notificationTypes.createdBy,
      to: r.users.id,
    }),
    updatedByUser: r.one.users({
      from: r.notificationTypes.updatedBy,
      to: r.users.id,
    }),
    emailLogs: r.many.notificationEmailLogs(),
  },
  notificationEmailLogs: {
    notificationType: r.one.notificationTypes({
      from: r.notificationEmailLogs.notificationId,
      to: r.notificationTypes.id,
    }),
    enqueuedByUser: r.one.users({
      from: r.notificationEmailLogs.enqueuedBy,
      to: r.users.id,
    }),
  },
  permissions: {
    rolePermissions: r.many.rolePermissions(),
  },
  rolePermissions: {
    role: r.one.roles({
      from: r.rolePermissions.roleId,
      to: r.roles.id,
    }),
    permission: r.one.permissions({
      from: r.rolePermissions.permissionId,
      to: r.permissions.id,
    }),
    updatedByUser: r.one.users({
      from: r.rolePermissions.updatedBy,
      to: r.users.id,
    }),
  },
  roles: {
    users: r.many.users(),
    rolePermissions: r.many.rolePermissions(),
  },
  users: {
    role: r.one.roles({
      from: r.users.roleId,
      to: r.roles.id,
    }),
    bidderCompany: r.one.bidders({
      from: r.users.bidderId,
      to: r.bidders.id,
    }),
    clientMemberships: r.many.userClients(),
  },
}));
