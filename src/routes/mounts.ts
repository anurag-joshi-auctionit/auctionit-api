import type { Router } from "express";
import liveRouter from "./live.js";
import bidderAuctionsRouter from "./bidder-auctions.js";
import clientAuctionsRouter from "./client-auctions.js";
import clientReportsRouter from "./client-reports.js";
import clientDashboardRouter from "./client-dashboard.js";
import bidderDashboardRouter from "./bidder-dashboard.js";
import authRouter from "./auth.js";
import auctionsRouter from "./auctions.js";
import questionTemplatesRouter from "./question-templates.js";
import auctionRaStagesRouter from "./auction-ra-stages.js";
import bidderRaStagesRouter from "./bidder-ra-stages.js";
import filesRouter from "./files.js";
import smsRouter from "./sms.js";
import emailRouter from "./email.js";
import emdRouter from "./emd.js";
import bidderEmdRouter from "./bidder-emd.js";
import subscriptionRouter from "./subscriptions.js";
import adminSubscriptionsRouter from "./admin-subscriptions.js";
import adminDashboardRouter from "./admin-dashboard.js";
import adminReportsRouter from "./admin-reports.js";
import biddersRouter from "./bidders.js";
import bankAccountRouter from "./bank-account.js";
import clientsRouter from "./clients.js";
import locationsRouter from "./locations.js";
import materialsRouter from "./materials.js";
import itemsRouter from "./items.js";
import benchmarkMaterialLocationsRouter from "./benchmark-material-locations.js";
import benchmarkPricesRouter from "./benchmark-prices.js";
import bidderDocumentTypesMasterRouter from "./masters/bidder-document-types.js";
import clientDocumentTypesMasterRouter from "./masters/client-document-types.js";
import subscriptionTypesMasterRouter from "./masters/subscription-types.js";
import paymentTypesMasterRouter from "./masters/payment-types.js";
import emdForfeitureDispositionsMasterRouter from "./masters/emd-forfeiture-dispositions.js";
import auctionDocumentTypesMasterRouter from "./masters/auction-document-types.js";
import benchmarkMaterialsMasterRouter from "./masters/benchmark-materials.js";
import benchmarkLocationsMasterRouter from "./masters/benchmark-locations.js";
import uomsMasterRouter from "./masters/uoms.js";
import usersRouter from "./users.js";
import liftingRouter from "./lifting.js";
import liftingClientsRouter from "./lifting-clients.js";
import liftingBidderDispositionMasterRouter from "./masters/lifting-bidder-disposition.js";
import liftingClientDispositionMasterRouter from "./masters/lifting-client-disposition.js";
import serviceInvoicesRouter from "./service-invoices.js";
import rolesRouter from "./roles.js";

export type RouteMount = {
  prefix: string;
  router: Router;
  /** Swagger tag every operation under this mount is grouped under. */
  tag: string;
};

// Mount order matters: more specific prefixes (`/auctions/me`, `/lifting/clients`)
// must come before the broader ones they share a prefix with.
// The OpenAPI route inventory walks this same list, so a router added here is
// picked up by `pnpm openapi:check` automatically.
export const routeMounts: RouteMount[] = [
  { prefix: "/auth", router: authRouter, tag: "Auth" },
  { prefix: "/locations", router: locationsRouter, tag: "Locations" },
  { prefix: "/clients", router: clientsRouter, tag: "Clients" },
  { prefix: "/auctions/me", router: bidderAuctionsRouter, tag: "Bidder portal – Auctions" },
  { prefix: "/client/auctions", router: clientAuctionsRouter, tag: "Client portal – Auctions" },
  { prefix: "/client/reports", router: clientReportsRouter, tag: "Client portal – Reports" },
  { prefix: "/client/dashboard", router: clientDashboardRouter, tag: "Client portal – Dashboard" },
  { prefix: "/bidder/dashboard", router: bidderDashboardRouter, tag: "Bidder portal – Dashboard" },
  { prefix: "/auctions", router: auctionsRouter, tag: "Auctions" },
  {
    prefix: "/auctions",
    router: auctionRaStagesRouter,
    tag: "Auctions – RA Stages",
  },
  {
    prefix: "/question-templates",
    router: questionTemplatesRouter,
    tag: "Question templates",
  },
  {
    prefix: "/auctions/me",
    router: bidderRaStagesRouter,
    tag: "Bidder portal – RA Stages",
  },
  { prefix: "/files", router: filesRouter, tag: "Files" },
  { prefix: "/sms", router: smsRouter, tag: "SMS" },
  { prefix: "/email", router: emailRouter, tag: "Email" },
  { prefix: "/bidders", router: biddersRouter, tag: "Bidders" },
  { prefix: "/bank-account", router: bankAccountRouter, tag: "Bank account" },
  { prefix: "/materials", router: materialsRouter, tag: "Materials" },
  { prefix: "/items", router: itemsRouter, tag: "Items" },
  { prefix: "/service-invoices", router: serviceInvoicesRouter, tag: "Service invoices" },
  {
    prefix: "/benchmark-material-locations",
    router: benchmarkMaterialLocationsRouter,
    tag: "Benchmark material locations",
  },
  { prefix: "/benchmark-prices", router: benchmarkPricesRouter, tag: "Benchmark prices" },
  { prefix: "/emd", router: emdRouter, tag: "EMD" },
  {
    prefix: "/masters/bidder-document-types",
    router: bidderDocumentTypesMasterRouter,
    tag: "Masters – Bidder document types",
  },
  {
    prefix: "/masters/client-document-types",
    router: clientDocumentTypesMasterRouter,
    tag: "Masters – Client document types",
  },
  {
    prefix: "/masters/auction-document-types",
    router: auctionDocumentTypesMasterRouter,
    tag: "Masters – Auction document types",
  },
  {
    prefix: "/masters/benchmark-materials",
    router: benchmarkMaterialsMasterRouter,
    tag: "Masters – Benchmark materials",
  },
  {
    prefix: "/masters/benchmark-locations",
    router: benchmarkLocationsMasterRouter,
    tag: "Masters – Benchmark locations",
  },
  { prefix: "/masters/uoms", router: uomsMasterRouter, tag: "Masters – UOMs" },
  {
    prefix: "/masters/subscription-types",
    router: subscriptionTypesMasterRouter,
    tag: "Masters – Subscription types",
  },
  { prefix: "/masters/payment-types", router: paymentTypesMasterRouter, tag: "Masters – Payment types" },
  {
    prefix: "/masters/emd-forfeiture-dispositions",
    router: emdForfeitureDispositionsMasterRouter,
    tag: "Masters – EMD forfeiture dispositions",
  },
  { prefix: "/bidder-emd", router: bidderEmdRouter, tag: "Bidder portal – EMD" },
  { prefix: "/subscriptions", router: subscriptionRouter, tag: "Bidder portal – Subscriptions" },
  { prefix: "/live", router: liveRouter, tag: "Live auctions" },
  { prefix: "/admin/subscriptions", router: adminSubscriptionsRouter, tag: "Admin – Subscriptions" },
  { prefix: "/admin/dashboard", router: adminDashboardRouter, tag: "Admin – Dashboard" },
  { prefix: "/admin/reports", router: adminReportsRouter, tag: "Admin – Reports" },
  { prefix: "/lifting/clients", router: liftingClientsRouter, tag: "Lifting – Clients" },
  { prefix: "/lifting", router: liftingRouter, tag: "Lifting" },
  {
    prefix: "/masters/lifting-clients-disposition",
    router: liftingClientDispositionMasterRouter,
    tag: "Masters – Lifting client disposition",
  },
  {
    prefix: "/masters/lifting-bidder-disposition",
    router: liftingBidderDispositionMasterRouter,
    tag: "Masters – Lifting bidder disposition",
  },
  { prefix: "/users", router: usersRouter, tag: "Users" },
  { prefix: "/roles", router: rolesRouter, tag: "Roles" },
];
