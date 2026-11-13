import { z } from "../zod.js";

// Mirrors SmsTemplateItem / SendSmsOutcome in services/sms.service.ts.

export const SmsTemplate = z
  .object({
    id: z.number().int(),
    code: z.string(),
    templateId: z.string().openapi({ description: "DLT template id registered with the SMS gateway." }),
    purpose: z.string(),
    messageFormat: z.string().openapi({ example: "Your OTP is {otp}. Valid for {minutes} minutes." }),
    variables: z
      .array(z.string())
      .openapi({ description: "`{placeholder}` names found in `messageFormat`, de-duplicated, in order." }),
  })
  .openapi("SmsTemplate");

export const SmsTemplateList = z.object({ items: z.array(SmsTemplate) }).openapi("SmsTemplateList");

export const SmsSendResult = z
  .object({
    ok: z.literal(true),
    message: z.string().openapi({ description: "Final text sent, with variables substituted." }),
    gatewayStatus: z.number().int().openapi({ description: "HTTP status returned by the SMS gateway." }),
    gatewayResponse: z.string().openapi({ description: "Raw gateway response body." }),
  })
  .openapi("SmsSendResult");
