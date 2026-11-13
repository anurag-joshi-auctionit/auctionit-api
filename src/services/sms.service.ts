import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { smsTemplates } from "../db/schema/index.js";
import { sendSms } from "../lib/sms.js";

export type SmsTemplateItem = {
  id: number;
  code: string;
  templateId: string;
  purpose: string;
  messageFormat: string;
  variables: string[];
};

export type SendSmsOutcome = {
  message: string;
  gatewayStatus: number;
  gatewayResponse: string;
};

const VARIABLE_RE = /\{([^{}]+)\}/g;

/** Pull `{var}` placeholders out of a template, de-duplicated, in order. */
export function extractVariables(messageFormat: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of messageFormat.matchAll(VARIABLE_RE)) {
    const name = match[1]!.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Substitute every `{var}` with its value from `variables`. */
export function renderMessage(
  messageFormat: string,
  variables: Record<string, string>,
): string {
  return messageFormat.replace(VARIABLE_RE, (_full, rawName: string) => {
    const name = rawName.trim();
    return Object.prototype.hasOwnProperty.call(variables, name)
      ? variables[name]!
      : `{${name}}`;
  });
}

export class SmsService {
  async listTemplates(): Promise<SmsTemplateItem[]> {
    const rows = await db
      .select()
      .from(smsTemplates)
      .orderBy(asc(smsTemplates.id));

    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      templateId: r.templateId,
      purpose: r.purpose,
      messageFormat: r.messageFormat,
      variables: extractVariables(r.messageFormat),
    }));
  }

  async send(input: {
    templateId: number;
    mobile: string;
    variables: Record<string, string>;
  }): Promise<SendSmsOutcome> {
    const [template] = await db
      .select()
      .from(smsTemplates)
      .where(eq(smsTemplates.id, input.templateId))
      .limit(1);

    if (!template) {
      throw new Error("TEMPLATE_NOT_FOUND");
    }

    const required = extractVariables(template.messageFormat);
    const missing = required.filter(
      (name) => !input.variables[name]?.trim(),
    );
    if (missing.length > 0) {
      const err = new Error("MISSING_VARIABLES");
      (err as Error & { missing?: string[] }).missing = missing;
      throw err;
    }

    const message = renderMessage(template.messageFormat, input.variables);
    const result = await sendSms(input.mobile, message, template.templateId);

    if (!result.ok) {
      const err = new Error("GATEWAY_ERROR");
      (err as Error & { gatewayResponse?: string }).gatewayResponse =
        result.response;
      throw err;
    }

    return {
      message,
      gatewayStatus: result.status,
      gatewayResponse: result.response,
    };
  }
}

export const smsService = new SmsService();
