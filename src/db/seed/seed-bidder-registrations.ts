import pg from "pg";
import { env } from "../../env.js";
import {
  resolveAuditUserIdIfTimestamp,
  SEED_DEFAULT_USER_ID,
} from "./audit-user.js";
import { upsertBatched } from "./batch-write.js";
import { connectMssql } from "./mssql.js";

const SOURCE_SQL = `
SELECT
  Id                                          AS id,
  CompanyName                                 AS companyName,
  TypeofCompany                               AS typeOfCompanyId,
  BusinessActivity                            AS businessActivityId,
  Address                                     AS address,
  Country                                     AS legacyCountryId,
  State                                       AS legacyStateId,
  City                                        AS city,
  CityId                                      AS legacyCityId,
  PinCode                                     AS pincode,
  ContactNumber                               AS phone,
  SecondaryPhone                              AS secondaryPhone,
  RegisteredEmail                             AS registeredEmail,
  Email                                       AS email,
  FullName                                    AS fullName,
  Designation                                 AS designation,
  WhatsappNo                                  AS whatsappNumber,
  GST                                         AS gstin,
  InvailidGST                                 AS invalidGst,
  PAN                                         AS pan,
  Name                                        AS name,
  Place                                       AS place,
  CONVERT(varchar(33), regDate, 126)          AS regDate,
  DesignationPostedBy                         AS designationPostedBy,
  PanCardFileName                             AS panCardFileName,
  ProofofAddressFileName                      AS proofOfAddressFileName,
  GSTINFileName                               AS gstinFileName,
  CancelledChequeFileName                     AS cancelledChequeFileName,
  Others                                      AS othersFileName,
  SubCategoryIds                              AS subCategoryIds,
  ClientIds                                   AS clientIds,
  AdminStatus                                 AS adminStatus,
  Verified                                    AS verified,
  BidderCompid                                AS bidderId,
  Remark                                      AS remark,
  CRMId                                        AS crmId,
  IsClosed                                    AS isClosed,
  CONVERT(varchar(33), LastEmailSentDateTime, 126) AS lastEmailSentDateTime,
  NO_TimeEmailSent                            AS emailSentCount,
  IsEmailSent                                 AS isEmailSent,
  CONVERT(varchar(33), LastEmailSentDate, 126) AS lastEmailSentDate,
  IsReviseSubsEmailSent                       AS isReviseSubsEmailSent,
  FinalSaveClickCount                         AS finalSaveClickCount,
  SubscriptionTypeId                          AS subscriptionTypeId,
  BidderScopeId                               AS bidderScopeId,
  CONVERT(varchar(10), FromDate, 126)         AS fromDate,
  CONVERT(varchar(10), ToDate, 126)           AS toDate,
  SubscriptionPrice                           AS subscriptionPrice,
  GstAmount                                   AS gstAmount,
  Amount                                      AS amount,
  TransId                                     AS transactionId,
  PaymentMode                                 AS paymentMode,
  CONVERT(varchar(33), PaymentDate, 126)      AS paymentDate,
  PaymentStatus                               AS paymentStatus,
  PaymentRemarks                              AS paymentRemarks,
  PaymentUpdatedBy                            AS paymentUpdatedBy,
  CONVERT(varchar(33), PaymentUpdatedDate, 126) AS paymentUpdatedAt,
  AccountNumber                               AS accountNumber,
  BankName                                    AS bankName,
  IFSCCode                                    AS ifscCode,
  CONVERT(varchar(33), CreatedOn, 126)        AS createdAt
FROM tbl_Data_UserReg
`;

const HEAD_SQL = `
INSERT INTO bidder_registrations (
  id, company_name, type_of_company_id, business_activity_id,
  address, legacy_country_id, legacy_state_id, city, legacy_city_id, pincode,
  phone, secondary_phone, registered_email, email, full_name, designation,
  whatsapp_number,
  gstin, invalid_gst, pan,
  name, place, reg_date, designation_posted_by,
  pan_card_file_name, proof_of_address_file_name, gstin_file_name,
  cancelled_cheque_file_name, others_file_name,
  sub_category_ids, client_ids,
  admin_status, verified, bidder_id, remark, crm_id, is_closed,
  last_email_sent_date_time, email_sent_count, is_email_sent,
  last_email_sent_date, is_revise_subs_email_sent, final_save_click_count,
  subscription_type_id, bidder_scope_id, from_date, to_date,
  subscription_price, gst_amount, amount,
  transaction_id, payment_mode, payment_date, payment_status, payment_remarks,
  payment_updated_by, payment_updated_at,
  account_number, bank_name, ifsc_code,
  created_at, created_by
)`;

const TAIL_SQL = `
ON CONFLICT (id) DO UPDATE SET
  company_name = EXCLUDED.company_name,
  type_of_company_id = EXCLUDED.type_of_company_id,
  business_activity_id = EXCLUDED.business_activity_id,
  address = EXCLUDED.address,
  legacy_country_id = EXCLUDED.legacy_country_id,
  legacy_state_id = EXCLUDED.legacy_state_id,
  city = EXCLUDED.city,
  legacy_city_id = EXCLUDED.legacy_city_id,
  pincode = EXCLUDED.pincode,
  phone = EXCLUDED.phone,
  secondary_phone = EXCLUDED.secondary_phone,
  registered_email = EXCLUDED.registered_email,
  email = EXCLUDED.email,
  full_name = EXCLUDED.full_name,
  designation = EXCLUDED.designation,
  whatsapp_number = EXCLUDED.whatsapp_number,
  gstin = EXCLUDED.gstin,
  invalid_gst = EXCLUDED.invalid_gst,
  pan = EXCLUDED.pan,
  name = EXCLUDED.name,
  place = EXCLUDED.place,
  reg_date = EXCLUDED.reg_date,
  designation_posted_by = EXCLUDED.designation_posted_by,
  pan_card_file_name = EXCLUDED.pan_card_file_name,
  proof_of_address_file_name = EXCLUDED.proof_of_address_file_name,
  gstin_file_name = EXCLUDED.gstin_file_name,
  cancelled_cheque_file_name = EXCLUDED.cancelled_cheque_file_name,
  others_file_name = EXCLUDED.others_file_name,
  sub_category_ids = EXCLUDED.sub_category_ids,
  client_ids = EXCLUDED.client_ids,
  admin_status = EXCLUDED.admin_status,
  verified = EXCLUDED.verified,
  bidder_id = EXCLUDED.bidder_id,
  remark = EXCLUDED.remark,
  crm_id = EXCLUDED.crm_id,
  is_closed = EXCLUDED.is_closed,
  last_email_sent_date_time = EXCLUDED.last_email_sent_date_time,
  email_sent_count = EXCLUDED.email_sent_count,
  is_email_sent = EXCLUDED.is_email_sent,
  last_email_sent_date = EXCLUDED.last_email_sent_date,
  is_revise_subs_email_sent = EXCLUDED.is_revise_subs_email_sent,
  final_save_click_count = EXCLUDED.final_save_click_count,
  subscription_type_id = EXCLUDED.subscription_type_id,
  bidder_scope_id = EXCLUDED.bidder_scope_id,
  from_date = EXCLUDED.from_date,
  to_date = EXCLUDED.to_date,
  subscription_price = EXCLUDED.subscription_price,
  gst_amount = EXCLUDED.gst_amount,
  amount = EXCLUDED.amount,
  transaction_id = EXCLUDED.transaction_id,
  payment_mode = EXCLUDED.payment_mode,
  payment_date = EXCLUDED.payment_date,
  payment_status = EXCLUDED.payment_status,
  payment_remarks = EXCLUDED.payment_remarks,
  payment_updated_by = EXCLUDED.payment_updated_by,
  payment_updated_at = EXCLUDED.payment_updated_at,
  account_number = EXCLUDED.account_number,
  bank_name = EXCLUDED.bank_name,
  ifsc_code = EXCLUDED.ifsc_code,
  created_at = EXCLUDED.created_at,
  created_by = EXCLUDED.created_by
`;


type SourceRow = {
  id: number;
  companyName: string | null;
  typeOfCompanyId: number | null;
  businessActivityId: number | null;
  address: string | null;
  legacyCountryId: number | null;
  legacyStateId: number | null;
  city: string | null;
  legacyCityId: number | null;
  pincode: string | null;
  phone: string | null;
  secondaryPhone: string | null;
  registeredEmail: string | null;
  email: string | null;
  fullName: string | null;
  designation: string | null;
  whatsappNumber: string | null;
  gstin: string | null;
  invalidGst: number | null;
  pan: string | null;
  name: string | null;
  place: string | null;
  regDate: string | null;
  designationPostedBy: string | null;
  panCardFileName: string | null;
  proofOfAddressFileName: string | null;
  gstinFileName: string | null;
  cancelledChequeFileName: string | null;
  othersFileName: string | null;
  subCategoryIds: string | null;
  clientIds: string | null;
  adminStatus: number | null;
  verified: number | null;
  bidderId: number | null;
  remark: string | null;
  crmId: number | null;
  isClosed: boolean | null;
  lastEmailSentDateTime: string | null;
  emailSentCount: number | null;
  isEmailSent: number | null;
  lastEmailSentDate: string | null;
  isReviseSubsEmailSent: boolean | null;
  finalSaveClickCount: number | null;
  subscriptionTypeId: number | null;
  bidderScopeId: number | null;
  fromDate: string | null;
  toDate: string | null;
  subscriptionPrice: string | number | null;
  gstAmount: string | number | null;
  amount: string | number | null;
  transactionId: string | null;
  paymentMode: number | null;
  paymentDate: string | null;
  paymentStatus: string | null;
  paymentRemarks: string | null;
  paymentUpdatedBy: number | null;
  paymentUpdatedAt: string | null;
  accountNumber: string | null;
  bankName: string | null;
  ifscCode: string | null;
  createdAt: string;
};

function asString(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function asNumeric(v: string | number | null | undefined): string | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : null;
}

function asBool(v: boolean | number | null | undefined): boolean | null {
  if (v == null) return null;
  return Boolean(v);
}

async function main() {
  const started = Date.now();
  const mssqlPool = await connectMssql();
  const pgPool = new pg.Pool({ connectionString: env.DATABASE_URL });

  try {
    const result = await mssqlPool.request().query<SourceRow>(SOURCE_SQL);
    console.log(
      `Pulled ${result.recordset.length} bidder registration rows from MSSQL.`,
    );
    if (result.recordset.length === 0) {
      console.log("Nothing to seed.");
      return;
    }

    const [bidderIdsResult, userIdsResult] = await Promise.all([
      pgPool.query<{ id: number }>("SELECT id FROM bidders"),
      pgPool.query<{ id: number }>("SELECT id FROM users"),
    ]);
    const validBidderIds = new Set(bidderIdsResult.rows.map((r) => r.id));
    const validUserIds = new Set(userIdsResult.rows.map((r) => r.id));
    validUserIds.add(SEED_DEFAULT_USER_ID);

    // Build rows in-memory (62 params each)
    const rows: unknown[][] = [];
    let nulledBidder = 0;

    for (const r of result.recordset) {
      const bidderId =
        r.bidderId != null && validBidderIds.has(r.bidderId) ? r.bidderId : null;
      if (r.bidderId != null && bidderId === null) nulledBidder++;

      // Legacy UserReg has no CreatedBy; default to seed user when created_at is set.
      const createdBy = resolveAuditUserIdIfTimestamp(r.createdAt, null, validUserIds);
      const paymentUpdatedBy = resolveAuditUserIdIfTimestamp(
        r.paymentUpdatedAt,
        r.paymentUpdatedBy,
        validUserIds,
      );

      rows.push([
        r.id,
        asString(r.companyName),
        r.typeOfCompanyId,
        r.businessActivityId,
        asString(r.address),
        r.legacyCountryId,
        r.legacyStateId,
        asString(r.city),
        r.legacyCityId,
        asString(r.pincode),
        asString(r.phone),
        asString(r.secondaryPhone),
        asString(r.registeredEmail),
        asString(r.email),
        asString(r.fullName),
        asString(r.designation),
        asString(r.whatsappNumber),
        asString(r.gstin),
        r.invalidGst,
        asString(r.pan),
        asString(r.name),
        asString(r.place),
        r.regDate,
        asString(r.designationPostedBy),
        asString(r.panCardFileName),
        asString(r.proofOfAddressFileName),
        asString(r.gstinFileName),
        asString(r.cancelledChequeFileName),
        asString(r.othersFileName),
        asString(r.subCategoryIds),
        asString(r.clientIds),
        r.adminStatus,
        r.verified,
        bidderId,
        asString(r.remark),
        r.crmId,
        asBool(r.isClosed),
        r.lastEmailSentDateTime,
        r.emailSentCount,
        r.isEmailSent,
        r.lastEmailSentDate,
        asBool(r.isReviseSubsEmailSent),
        r.finalSaveClickCount,
        r.subscriptionTypeId,
        r.bidderScopeId,
        r.fromDate,
        r.toDate,
        asNumeric(r.subscriptionPrice),
        asNumeric(r.gstAmount),
        asNumeric(r.amount),
        asString(r.transactionId),
        r.paymentMode,
        r.paymentDate,
        asString(r.paymentStatus),
        asString(r.paymentRemarks),
        paymentUpdatedBy,
        r.paymentUpdatedAt,
        asString(r.accountNumber),
        asString(r.bankName),
        asString(r.ifscCode),
        r.createdAt,
        createdBy,
      ]);
    }

    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      await upsertBatched(client, "bidder_registrations", HEAD_SQL, TAIL_SQL, rows);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    console.log(
      `Upserted ${rows.length} rows into bidder_registrations ` +
        `(nulled bidder_id on ${nulledBidder} rows) ` +
        `in ${Date.now() - started}ms.`,
    );
  } finally {
    await mssqlPool.close();
    await pgPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
