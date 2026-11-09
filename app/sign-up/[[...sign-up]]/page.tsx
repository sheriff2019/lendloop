import Link from "next/link";
import { SignUp } from "@clerk/nextjs";
import { Logo } from "@/components/ui";

export const metadata = { title: "Create an account" };

export default function SignUpPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
      <Link href="/" aria-label="LendLoop home"><Logo /></Link>
      <SignUp fallbackRedirectUrl="/tools" signInFallbackRedirectUrl="/tools" />
    </div>
  );
}
