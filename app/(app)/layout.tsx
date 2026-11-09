import type { ReactNode } from "react";
import { auth } from "@clerk/nextjs/server";
import AppShell from "@/components/AppShell";

/**
 * Every signed-in page lives under this layout. Signed-out visitors are sent to
 * sign in here, on the server. (The data itself is protected separately: every
 * Convex function checks the caller — see convex/lib/auth.ts.)
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  await auth.protect();
  return <AppShell>{children}</AppShell>;
}
