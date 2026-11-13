import pg from "pg";
import { env } from "../../env.js";
import {
  SMS_TEMPLATE_CODES,
  type SmsTemplateCode,
} from "../schema/sms-templates.js";

type SmsTemplateSeed = {
  code: SmsTemplateCode;
  templateId: string;
  purpose: string;
  messageFormat: string;
};

const SMS_TEMPLATES: SmsTemplateSeed[] = [
  {
    code: SMS_TEMPLATE_CODES.otp,
    templateId: "1207161778554839403",
    purpose: "OTP — password reset / forgot-password resend / login verification",
    messageFormat:
      "{OTP} is your Authorization OTP for {purpose}. OTP will expire in 15 minutes. Regards- JindalX",
  },
  {
    code: SMS_TEMPLATE_CODES.credentialsReset,
    templateId: "1207161554332332958",
    purpose: "Reset/new credentials",
    messageFormat:
      "Your Password for www.auctionit.in has been reset: Login Id:{user} Password:{pwd}. Regards Auctionit",
  },
  {
    code: SMS_TEMPLATE_CODES.registrationWelcome,
    templateId: "1207161554317837477",
    purpose: "New-user registration welcome",
    messageFormat:
      "Thank you for registering with www.auctionit.in. Your user ID and Password is: User Id:{user} Password:{pwd}; Regards Auctionit",
  },
];

const UPSERT_SQL = `
INSERT INTO sms_templates (code, template_id, purpose, message_format)
VALUES ($1, $2, $3, $4)
ON CONFLICT (code) DO UPDATE SET
  template_id = EXCLUDED.template_id,
  purpose = EXCLUDED.purpose,
  message_format = EXCLUDED.message_format
`;

async function main() {
  const started = Date.now();
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const t of SMS_TEMPLATES) {
      await client.query(UPSERT_SQL, [
        t.code,
        t.templateId,
        t.purpose,
        t.messageFormat,
      ]);
    }
    await client.query("COMMIT");
    console.log(
      `Upserted ${SMS_TEMPLATES.length} sms templates in ${Date.now() - started}ms.`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
