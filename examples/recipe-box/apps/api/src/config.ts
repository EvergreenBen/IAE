import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  RESEND_API_KEY: z.string().min(1),
  PORT: z.coerce.number().default(8787),
});

export const config = schema.parse(process.env);
export type Config = z.infer<typeof schema>;
