import { env } from "../env.js";

export type SendSmsResult = {
  ok: boolean;
  status: number;
  response: string;
};

/**
 * Low-level send: hits the bulk-SMS gateway with a fully-rendered message.
 * The gateway is GET-based; credentials and DLT params come from env, while the
 * per-message DLT template id is passed in (each body must match its template).
 *
 * The gateway returns HTTP 200 even on failure, so success is determined by the
 * configured success token appearing in the response body — not the HTTP status.
 */
export async function sendSms(
  mobile: string,
  message: string,
  dltTemplateId: string,
): Promise<SendSmsResult> {
  // Gateway expects digits only — strip a leading "+" if E.164 was passed in.
  // A bare 10-digit number gets the country code prefixed (gateway needs it).
  const digits = mobile.replace(/^\+/, "").replace(/\D/g, "");
  const to = digits.length === 10 ? `${env.SMS_COUNTRY_CODE}${digits}` : digits;

  const url = new URL(env.SMS_API_URL);
  url.searchParams.set("username", env.SMS_USERNAME);
  url.searchParams.set("password", env.SMS_PASSWORD);
  url.searchParams.set("type", env.SMS_TYPE);
  url.searchParams.set("sender", env.SMS_SENDER);
  url.searchParams.set("mobile", to);
  url.searchParams.set("message", message);
  url.searchParams.set("PEID", env.SMS_DLT_PEID);
  url.searchParams.set("HeaderId", env.SMS_DLT_HEADER_ID);
  url.searchParams.set("templateId", dltTemplateId);

  const res = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(15_000),
  });
  const response = (await res.text()).trim();

  // Positive match on the success token — the gateway 200s on failure too.
  const ok = res.ok && response.includes(env.SMS_SUCCESS_TOKEN);
  return { ok, status: res.status, response };
}
