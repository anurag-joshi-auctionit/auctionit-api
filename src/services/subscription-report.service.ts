import { and, count, desc, eq, gte, lte, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { bidders } from "../db/schema/bidders.js";
import { locations } from "../db/schema/locations.js";
import { paymentTypes } from "../db/schema/payment-types.js";
import { subscriptions } from "../db/schema/subscriptions.js";
import { subscriptionTypes } from "../db/schema/subscription-types.js";
import { users } from "../db/schema/users.js";
import { clampPagination } from "./list-query.js";

export type SubscriptionReportParams = {
  from: string;
  to: string;
};

export type SubscriptionReportRow = {
  subscriptionId: number;
  bidderId: number;
  bidderName: string | null;
  bidderAddress: string | null;
  email: string | null;
  mobile: string | null;
  subscriptionTypeName: string | null;
  paymentDate: string | null;
  paymentModeName: string | null;
  transactionId: string | null;
  amount: number;
  fromDate: string | null;
  toDate: string | null;
};

export type SubscriptionReportPage = {
  items: SubscriptionReportRow[];
  total: number;
  totalAmount: number;
  subscriberCount: number;
  page: number;
  pageSize: number;
};

const rowSelect = {
  subscriptionId: subscriptions.id,
  bidderId: subscriptions.bidderId,
  bidderName: bidders.companyName,
  address: bidders.address,
  city: sql<string | null>`coalesce(${locations.city}, ${bidders.city})`,
  state: sql<string | null>`coalesce(${locations.state}, ${bidders.state})`,
  pincode: bidders.pincode,
  email: users.emailId,
  mobile: users.phoneNumber,
  subscriptionTypeName: subscriptionTypes.name,
  paymentDate: subscriptions.paymentDate,
  paymentModeName: paymentTypes.name,
  transactionId: subscriptions.transactionId,
  amount: subscriptions.amount,
  fromDate: subscriptions.fromDate,
  toDate: subscriptions.toDate,
};

type RawRow = {
  subscriptionId: number;
  bidderId: number;
  bidderName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  email: string | null;
  mobile: string | null;
  subscriptionTypeName: string | null;
  paymentDate: string | null;
  paymentModeName: string | null;
  transactionId: string | null;
  amount: string;
  fromDate: string | null;
  toDate: string | null;
};

function whereFor(params: SubscriptionReportParams) {
  return and(
    gte(subscriptions.paymentDate, params.from),
    lte(subscriptions.paymentDate, params.to),
    ne(subscriptions.invoiceStatus, "cancelled"),
  );
}

function trimOrNull(value: string | null | undefined): string | null {
  const t = value?.trim();
  return t ? t : null;
}

function composeAddress(r: RawRow): string | null {
  const parts = [r.address, r.city, r.state, r.pincode]
    .map(trimOrNull)
    .filter((p): p is string => p != null);
  return parts.length > 0 ? parts.join(", ") : null;
}

function mapRow(r: RawRow): SubscriptionReportRow {
  return {
    subscriptionId: r.subscriptionId,
    bidderId: r.bidderId,
    bidderName: trimOrNull(r.bidderName),
    bidderAddress: composeAddress(r),
    email: trimOrNull(r.email),
    mobile: trimOrNull(r.mobile),
    subscriptionTypeName: trimOrNull(r.subscriptionTypeName),
    paymentDate: r.paymentDate,
    paymentModeName: trimOrNull(r.paymentModeName),
    transactionId: trimOrNull(r.transactionId),
    amount: Number(r.amount ?? 0),
    fromDate: r.fromDate,
    toDate: r.toDate,
  };
}

function rowsQuery(params: SubscriptionReportParams) {
  return db
    .select(rowSelect)
    .from(subscriptions)
    .leftJoin(bidders, eq(bidders.id, subscriptions.bidderId))
    .leftJoin(locations, eq(locations.id, bidders.locationId))
    .leftJoin(users, eq(users.bidderId, subscriptions.bidderId))
    .leftJoin(
      subscriptionTypes,
      eq(subscriptionTypes.id, subscriptions.subscriptionTypeId),
    )
    .leftJoin(paymentTypes, eq(paymentTypes.id, subscriptions.paymentMode))
    .where(whereFor(params))
    .orderBy(desc(subscriptions.paymentDate), desc(subscriptions.id));
}

export class SubscriptionReportService {
  async page(
    params: SubscriptionReportParams & { page: number; pageSize: number },
  ): Promise<SubscriptionReportPage> {
    const { page, pageSize, offset } = clampPagination(
      params.page,
      params.pageSize,
    );

    const [rows, [agg]] = await Promise.all([
      rowsQuery(params).limit(pageSize).offset(offset),
      db
        .select({
          total: count(),
          totalAmount: sql<string>`coalesce(sum(${subscriptions.amount}), 0)`,
          subscriberCount: sql<string>`count(distinct ${subscriptions.bidderId})`,
        })
        .from(subscriptions)
        .where(whereFor(params)),
    ]);

    return {
      items: rows.map(mapRow),
      total: Number(agg?.total ?? 0),
      totalAmount: Number(agg?.totalAmount ?? 0),
      subscriberCount: Number(agg?.subscriberCount ?? 0),
      page,
      pageSize,
    };
  }

  async all(params: SubscriptionReportParams): Promise<SubscriptionReportRow[]> {
    const rows = await rowsQuery(params);
    return rows.map(mapRow);
  }
}

export const subscriptionReportService = new SubscriptionReportService();
