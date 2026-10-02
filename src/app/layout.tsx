import type { Metadata } from "next";
import "./fonts.css";
import "./globals.css";

import { SourceLink } from "@/components/source-link";
import { sourceUrl } from "@/lib/runtime";

/*
 * Four faces, each with a job, which is how a real diner sign works: a script
 * logotype (Pacifico), fat slab for the shouting (Alfa Slab One), a workhorse
 * for the reading (Archivo), and a typewriter for anything that behaves like
 * a docket (Courier Prime). Self-hosted in ./fonts.css, which also defines
 * the --font-script/--font-slab/--font-archivo/--font-courier variables.
 */

export const metadata: Metadata = {
  title: "Pretty Please Print",
  description: "Invite-only 3D print requests for the office.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="plate flex min-h-screen flex-col bg-cream text-ink antialiased">
        <div className="flex-1">{children}</div>
        {/* AGPL-3.0 section 13 wants the source offer in front of people using
            the app over a network. In the root layout it reaches every page,
            signed in or not, and is resolved server-side so a fork can point
            it at its own source with SOURCE_URL. */}
        <SourceLink href={sourceUrl()} />
      </body>
    </html>
  );
}
