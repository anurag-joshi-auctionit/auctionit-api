import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../env.js";
import { sendViaSendGrid } from "./sendgrid.js";

export type EmailAttachment = {
  content: string; // base64
  filename: string;
  type?: string;
  disposition?: "attachment" | "inline";
};

export type SendMailInput = {
  to: string | string[];
  subject: string;
  html: string;
  cc?: string | string[];
  bcc?: string | string[];
  attachments?: EmailAttachment[];
};

export type SendMailResult = {
  provider: "sendgrid" | "smtp";
  messageId: string | null;
};

let _smtpTransport: Transporter | null = null;

function smtpConfigured(): boolean {
  return Boolean(env.EMAIL_HOST && env.EMAIL_USERNAME && env.EMAIL_PASSWORD);
}

function smtpTransport(): Transporter {
  if (!smtpConfigured()) {
    throw new Error("SMTP_NOT_CONFIGURED");
  }
  if (_smtpTransport) return _smtpTransport;
  _smtpTransport = nodemailer.createTransport({
    host: env.EMAIL_HOST,
    port: env.EMAIL_PORT,
    secure: env.EMAIL_SECURE,
    auth: {
      user: env.EMAIL_USERNAME,
      pass: env.EMAIL_PASSWORD,
    },
    tls: {
      // Legacy mail.auctionit.in may present a self-signed/mismatched cert.
      rejectUnauthorized: false,
    },
  });
  return _smtpTransport;
}

async function sendViaSmtp(input: SendMailInput): Promise<SendMailResult> {
  const info = await smtpTransport().sendMail({
    from: {
      name: env.EMAIL_FROM_NAME,
      address: env.EMAIL_USERNAME,
    },
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    html: input.html,
    attachments: input.attachments?.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content, "base64"),
      contentType: a.type,
      contentDisposition: a.disposition,
    })),
  });

  return {
    provider: "smtp",
    messageId: info.messageId ?? null,
  };
}

/**
 * Prefer SendGrid when `SENDGRID_API_KEY` is set; otherwise use in-house SMTP.
 */
export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  if (env.SENDGRID_API_KEY) {
    const result = await sendViaSendGrid(input);
    return { provider: "sendgrid", messageId: result.messageId };
  }
  return sendViaSmtp(input);
}
