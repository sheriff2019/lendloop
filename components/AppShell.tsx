"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Logo, Notice, Spinner, cx } from "@/components/ui";
import { errorMessage } from "@/lib/format";

/**
 * Signed-in shell. Waits until Convex has accepted the Clerk token, makes sure
 * the caller has a users row (users.store), then shows the app.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const store = useMutation(api.users.store);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    store({})
      .then(() => !cancelled && setReady(true))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, store]);

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(t);
  }, []);

  if (!ready) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <Logo />
        {error ? (
          <Notice tone="red" role="alert">{error}</Notice>
        ) : (
          <p className="flex items-center gap-2 text-muted">
            <Spinner /> {isLoading ? "Checking your sign-in…" : "Getting your account ready…"}
          </p>
        )}
        {slow && !isAuthenticated && !isLoading ? (
          <Notice tone="amber">
            Signed in with Clerk, but Convex has not accepted the session. Check that the Clerk “convex” JWT template
            (or Convex integration) is enabled and that <code>CLERK_JWT_ISSUER_DOMAIN</code> is set in Convex.
          </Notice>
        ) : null}
      </div>
    );
  }

  return (
    <div className="min-h-dvh">
      <AppHeader />
      <main className="mx-auto w-full max-w-[1200px] px-4 pb-16 pt-7 sm:px-6">{children}</main>
    </div>
  );
}

function AppHeader() {
  const me = useQuery(api.users.me);
  const counts = useQuery(api.loans.counts);
  const pathname = usePathname();
  const links = [
    { href: "/tools", label: "Tools" },
    { href: "/listings", label: "My listings" },
    { href: "/requests", label: "Requests", badge: counts?.incomingPending ?? 0 },
    ...(me?.role === "admin" ? [{ href: "/admin", label: "Admin" }] : []),
  ];
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
        <Link href="/" aria-label="LendLoop home">
          <Logo />
        </Link>
        <nav aria-label="Main" className="order-3 flex w-full flex-wrap gap-1 sm:order-none sm:w-auto">
          {links.map((l) => {
            const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold",
                  active ? "bg-brand-soft text-brand-dark" : "text-ink-2 hover:bg-chip",
                )}
              >
                {l.label}
                {"badge" in l && l.badge ? (
                  <span className="rounded-full bg-red px-1.5 text-[11px] text-white" aria-label={`${l.badge} waiting`}>
                    {l.badge}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-2.5 text-sm">
          {me ? <span className="hidden sm:inline">{me.firstName}</span> : null}
          {me?.role === "admin" ? (
            <span className="rounded-md bg-ink px-1.5 py-0.5 text-[11px] font-bold text-white">ADMIN</span>
          ) : null}
          <UserButton />
        </div>
      </div>
    </header>
  );
}
