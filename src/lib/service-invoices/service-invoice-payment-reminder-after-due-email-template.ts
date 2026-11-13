/**
 * Legacy NotificationId 91 — tbl_Config_Client_Notification_Map
 * (Service Invoice Payment Reminder After Due Date).
 */

import {
  SERVICE_INVOICE_PAYMENT_REMINDER_CONTACT_EMAIL,
  SERVICE_INVOICE_PAYMENT_REMINDER_CONTACT_MOBILE,
  type ServiceInvoicePaymentReminderVars,
} from "./service-invoice-payment-reminder-before-due-email-template.js";

/** Optional BCC for this template only. Leave null/empty when unused. */
export const SERVICE_INVOICE_PAYMENT_REMINDER_AFTER_DUE_BCC: string | null =
  null;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildServiceInvoicePaymentReminderAfterDueSubject(
  vars: Pick<ServiceInvoicePaymentReminderVars, "invoiceNumber">,
): string {
  return `Invoice Payment Reminder - ${vars.invoiceNumber}`;
}

export function buildServiceInvoicePaymentReminderAfterDueHtml(
  vars: ServiceInvoicePaymentReminderVars,
): string {
  const invoiceNumber = escapeHtml(vars.invoiceNumber);
  const amount = escapeHtml(vars.amount);
  const paymentDueDate = escapeHtml(vars.paymentDueDate);
  const email = escapeHtml(
    vars.email ?? SERVICE_INVOICE_PAYMENT_REMINDER_CONTACT_EMAIL,
  );
  const mobile = escapeHtml(
    vars.mobileNumber ?? SERVICE_INVOICE_PAYMENT_REMINDER_CONTACT_MOBILE,
  );

  return `<html>
<body>
Dear Sir/Madam,
<br><br>
This email is to remind you that Invoice <strong>#${invoiceNumber}</strong> amounting to <strong>${amount}</strong> has become overdue on <strong>${paymentDueDate}</strong>. You are requested to immediately make payment. 
<br><br>
If you have already made the payment, please share the payment reference detail for tracking.

<br><br>
It is important to note that iCom Analytics Limits is registered as "Micro Enterprises" under MSMED Act, 2006 vide registration No. UDYAM-DL-11-0035885. Any payment to Micro and Small Enterprise under MSME Act, 2006 beyond due date attracts penal provisions as defined in MSMED Act, 2006 which includes interest @ 3 times of the bank rate notified by RBI, compounded monthly. Additionally, there are requirements of default reporting in financial statements and return to MCA. To avoid these future issues we strongly recommend you making payment on time.
<br><br>
We appreciate your business and attention to this matter. If you have any questions, please reach out to us at <strong>${email}</strong> or call <strong>${mobile}</strong>.
<br><br>
Thanks and with best regards,
<br>
Team AuctionIt
</body>
</html>`;
}
