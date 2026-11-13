import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env.js";

const DOWNLOAD_URL_EXPIRES_SECONDS = 60 * 60; // 1 hour

function buildClient(): S3Client {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error(
      "R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set in .env to use file storage.",
    );
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
}

let _client: S3Client | null = null;
function client(): S3Client {
  if (!_client) _client = buildClient();
  return _client;
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await client().send(
      new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
    );
    return true;
  } catch (err: unknown) {
    const status =
      err != null &&
      typeof err === "object" &&
      "$metadata" in err &&
      typeof (err as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode === "number"
        ? (err as { $metadata: { httpStatusCode: number } }).$metadata
            .httpStatusCode
        : null;
    if (status === 404) return false;
    const name =
      err != null && typeof err === "object" && "name" in err
        ? String((err as { name: string }).name)
        : "";
    if (name === "NotFound" || name === "NoSuchKey") return false;
    throw err;
  }
}

export async function putObject(opts: {
  key: string;
  body: Buffer;
  contentType?: string;
}): Promise<void> {
  await client().send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: opts.key,
      Body: opts.body,
      ContentType: opts.contentType,
    }),
  );
}

export async function deleteObject(key: string): Promise<void> {
  await client().send(
    new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
  );
}

/** S3/R2 has no rename — copy then delete the source key. */
export async function renameObject(opts: {
  fromKey: string;
  toKey: string;
}): Promise<void> {
  if (opts.fromKey === opts.toKey) return;
  await client().send(
    new CopyObjectCommand({
      Bucket: env.R2_BUCKET,
      CopySource: `${env.R2_BUCKET}/${opts.fromKey}`,
      Key: opts.toKey,
    }),
  );
  await deleteObject(opts.fromKey);
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const result = await client().send(
    new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
  );
  const body = result.Body;
  if (!body) {
    throw new Error(`R2 object has empty body: ${key}`);
  }
  const bytes = await body.transformToByteArray();
  return Buffer.from(bytes);
}

export async function getSignedDownloadUrl(
  key: string,
  opts?: {
    /** Override response Content-Disposition (e.g. `inline` to view in browser). */
    contentDisposition?: string;
    /** Override response Content-Type. */
    contentType?: string;
  },
): Promise<string> {
  return getSignedUrl(
    client(),
    new GetObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      ...(opts?.contentDisposition
        ? { ResponseContentDisposition: opts.contentDisposition }
        : {}),
      ...(opts?.contentType
        ? { ResponseContentType: opts.contentType }
        : {}),
    }),
    { expiresIn: DOWNLOAD_URL_EXPIRES_SECONDS },
  );
}
