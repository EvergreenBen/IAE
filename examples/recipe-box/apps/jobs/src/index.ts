import { Pool } from "pg";
import { makeThumbnail } from "./thumbs/worker";
import { sendWeeklyDigest } from "./digest/weekly";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const handlers: Record<string, (payload: any) => Promise<void>> = {
  thumbnail: makeThumbnail,
  weekly_digest: sendWeeklyDigest,
};

async function tick() {
  // SKIP LOCKED lets several workers poll the same `jobs` table safely.
  const { rows } = await pool.query(
    `UPDATE jobs SET done_at = now()
     WHERE id = (SELECT id FROM jobs WHERE done_at IS NULL AND run_at <= now()
                 ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING kind, payload`,
  );
  const job = rows[0];
  if (!job) return;
  try {
    await handlers[job.kind]?.(job.payload);
  } catch (err) {
    console.error(`job ${job.kind} failed`, err);
  }
}

setInterval(() => void tick(), 2000);
console.log("jobs worker polling every 2s");
