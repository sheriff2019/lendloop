import Link from "next/link";
import { SignIn } from "@clerk/nextjs";
import { Logo } from "@/components/ui";

export const metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
      <Link href="/" aria-label="LendLoop home"><Logo /></Link>
      <SignIn fallbackRedirectUrl="/tools" signUpFallbackRedirectUrl="/tools" />
    </div>
  );
}
