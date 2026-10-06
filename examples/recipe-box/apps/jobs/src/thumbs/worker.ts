import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";
import sharp from "sharp";

const s3 = new S3Client({ region: "us-east-1" });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const Bucket = process.env.S3_BUCKET!;

export async function makeThumbnail({ recipeId, key }: { recipeId: string; key: string }) {
  const original = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
  const input = Buffer.from(await original.Body!.transformToByteArray());

  const thumb = await sharp(input).resize(640, 400, { fit: "cover" }).webp({ quality: 80 }).toBuffer();
  const thumbKey = key.replace("originals/", "thumbs/") + ".webp";
  await s3.send(new PutObjectCommand({ Bucket, Key: thumbKey, Body: thumb, ContentType: "image/webp" }));

  const url = `https://${Bucket}.s3.amazonaws.com/${thumbKey}`;
  await pool.query("UPDATE recipes SET thumbnail_url = $1 WHERE id = $2", [url, recipeId]);
}
