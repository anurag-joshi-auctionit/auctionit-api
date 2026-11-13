import { env } from "../env.js";

export type SendGridAttachment = {
  content: string; // base64
  filename: string;
  type?: string;
  disposition?: "attachment" | "inline";
};

export type SendGridMailInput = {
  to: string | string[];
  subject: string;
  html: string;
  cc?: string | string[];
  bcc?: string | string[];
  attachments?: SendGridAttachment[];
};

export type SendGridMailResult = {
  statusCode: number;
  messageId: string | null;
};

function toArray(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value])
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * SendGrid v3 Mail Send API. Each call is one message (attachments may differ
 * per recipient, so we do not use personalizations batching).
 */
export async function sendViaSendGrid(
  input: SendGridMailInput,
): Promise<SendGridMailResult> {
  const apiKey = env.SENDGRID_API_KEY;
  if (!apiKey) {
    throw new Error("SENDGRID_NOT_CONFIGURED");
  }

  const to = toArray(input.to).map((email) => ({ email }));
  if (to.length === 0) {
    throw new Error("NO_RECIPIENT");
  }

  const body: Record<string, unknown> = {
    personalizations: [
      {
        to,
        ...(toArray(input.cc).length
          ? { cc: toArray(input.cc).map((email) => ({ email })) }
          : {}),
        ...(toArray(input.bcc).length
          ? { bcc: toArray(input.bcc).map((email) => ({ email })) }
          : {}),
      },
    ],
    from: {
      email: env.SENDGRID_FROM_EMAIL,
      name: env.SENDGRID_FROM_NAME,
    },
    subject: input.subject,
    content: [{ type: "text/html", value: input.html }],
  };

  if (input.attachments?.length) {
    body.attachments = input.attachments.map((a) => ({
      content: a.content,
      filename: a.filename,
      type: a.type ?? "application/octet-stream",
      disposition: a.disposition ?? "attachment",
    }));
  }

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `SENDGRID_SEND_FAILED:${res.status}${text ? ` ${text.slice(0, 500)}` : ""}`,
    );
  }

  return {
    statusCode: res.status,
    messageId: res.headers.get("x-message-id"),
  };
}
