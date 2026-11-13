import { enqueueEmail } from "./email-dispatch.service.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toList(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : value.split(",");
  return arr.map((s) => s.trim()).filter(Boolean);
}

export type SendEmailServiceInput = {
  to: string | string[];
  subject: string;
  html: string;
  cc?: string | string[];
  bcc?: string | string[];
  notificationId: number;
  auctionId?: number | null;
};

export class EmailService {
  async enqueue(input: SendEmailServiceInput): Promise<{ id: number }> {
    const to = toList(input.to);
    const cc = toList(input.cc);
    const bcc = toList(input.bcc);

    if (to.length === 0) {
      throw new Error("NO_RECIPIENT");
    }
    const invalid = [...to, ...cc, ...bcc].filter((e) => !EMAIL_RE.test(e));
    if (invalid.length > 0) {
      const err = new Error("INVALID_RECIPIENT");
      (err as Error & { invalid?: string[] }).invalid = invalid;
      throw err;
    }

    return enqueueEmail({
      notificationId: input.notificationId,
      emailTo: to.join(","),
      emailCc: cc.length ? cc.join(",") : null,
      emailBcc: bcc.length ? bcc.join(",") : null,
      emailBody: input.html,
      subject: input.subject,
      auctionId: input.auctionId ?? null,
      requiresAttachment: false,
    });
  }
}

export const emailService = new EmailService();
