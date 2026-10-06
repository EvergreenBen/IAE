import { Pool } from "pg";
import { Resend } from "resend";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendWeeklyDigest({ userId }: { userId: string }) {
  const { rows: [user] } = await pool.query("SELECT email, name FROM users WHERE id = $1", [userId]);
  const { rows: recipes } = await pool.query(
    "SELECT title FROM recipes WHERE user_id = $1 AND created_at > now() - interval '7 days'",
    [userId],
  );
  if (!user || recipes.length === 0) return;

  await resend.emails.send({
    from: "Recipe Box <digest@recipebox.example>",
    to: user.email,
    subject: `You saved ${recipes.length} recipes this week`,
    html: `<p>Hi ${user.name},</p><ul>${recipes.map((r) => `<li>${r.title}</li>`).join("")}</ul>`,
  });
}
