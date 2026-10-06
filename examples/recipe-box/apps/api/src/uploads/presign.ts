import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config";

export const uploads = new Hono<{ Variables: { userId: string } }>();
const s3 = new S3Client({ region: "us-east-1" });

uploads.post("/presign", async (c) => {
  const { contentType } = await c.req.json<{ contentType: string }>();
  if (!contentType.startsWith("image/")) return c.json({ error: "images only" }, 400);
  const key = `originals/${c.get("userId")}/${randomUUID()}`;
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: 300 },
  );
  return c.json({ url, key });
});
