"use client";

import Link from "next/link";
import { SignInButton, useAuth } from "@clerk/nextjs";
import { cx } from "./ui";

/** "Sign in to lend or borrow" (Clerk), or a way back into the app when already signed in. */
export function AuthCta({ large }: { large?: boolean }) {
  const { isLoaded, isSignedIn } = useAuth();
  const cls = cx(
    "inline-flex min-h-11 items-center justify-center rounded-[10px] bg-brand px-5 font-semibold text-white hover:bg-brand-dark",
    large ? "text-base" : "text-[15px]",
  );
  if (isLoaded && isSignedIn) {
    return (
      <Link href="/tools" className={cls}>
        Open LendLoop
      </Link>
    );
  }
  return (
    <SignInButton mode="modal" forceRedirectUrl="/tools" signUpForceRedirectUrl="/tools">
      <button type="button" className={cls}>
        Sign in to lend or borrow
      </button>
    </SignInButton>
  );
}
