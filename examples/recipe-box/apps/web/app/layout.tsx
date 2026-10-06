import type { ReactNode } from "react";
import Link from "next/link";
import { getSession } from "@/lib/session";

export const metadata = { title: "Recipe Box" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/">Recipe Box</Link>
          {session ? <Link href="/profile">Profile</Link> : <a href="/api/auth/google">Sign in</a>}
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
