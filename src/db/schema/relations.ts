import { defineRelations } from "drizzle-orm/relations";
import { auctionLotBidderMaps } from "./auction-lot-bidder-maps.js";
import { auctionDocumentTypes } from "./auction-document-types.js";
import { auctionDocuments } from "./auction-documents.js";
import { auctionLotConfirmationDocuments } from "./auction-lot-confirmation-documents.js";
import { auctionCatalogueNotifications } from "./auction-catalogue-notifications.js";
import { auctionLotEmdRanges } from "./auction-lot-emd-ranges.js";
import { auctionLotItems, auctionLots } from "./auction-lots.js";
import { auctions } from "./auctions.js";
import { benchmarkLocations } from "./benchmark-locations.js";
import { benchmarkMaterialLocations } from "./benchmark-material-locations.js";
import { benchmarkMaterials } from "./benchmark-materials.js";
import { benchmarkPrices } from "./benchmark-prices.js";
import { bidderDocumentTypes } from "./bidder-document-types.js";
import { bidderDocumentLogs } from "./bidder-document-logs.js";
import { clientDocumentTypes } from "./client-document-types.js";
import { clientDocumentLogs } from "./client-document-logs.js";
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
import { serviceInvoices } from "./service-invoices.js";
import { serviceInvoiceDocumentTypes } from "./service-invoice-document-types.js";
import { serviceInvoiceDocuments } from "./service-invoice-documents.js";
import { users } from "./users.js";
import { uoms } from "./uoms.js";

const schema = {
  auctionLotBidderMaps,
  auctionDocumentTypes,
  auctionDocuments,
  auctionLotConfirmationDocuments,
  auctionCatalogueNotifications,
  auctionLotEmdRanges,
  auctionLotItems,
  auctionLots,
  auctions,
  benchmarkLocations,
  benchmarkMaterialLocations,
  benchmarkMaterials,
  benchmarkPrices,
  bidderDocumentTypes,
  bidderDocumentLogs,
  clientDocumentTypes,
  clientDocumentLogs,
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
  serviceInvoices,
  serviceInvoiceDocumentTypes,
  serviceInvoiceDocuments,
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
    bidder: r.one.bidders({
      from: r.auctionLotBidderMaps.bidderId,
      to: r.bidders.id,
    }),
  },
  auctionLotEmdRanges: {
    auction: r.one.auctions({
      from: r.auctionLotEmdRanges.auctionId,
      to: r.auctions.id,
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
  roles: {
    users: r.many.users(),
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
