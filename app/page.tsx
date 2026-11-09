import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { Logo } from "@/components/ui";
import PublicTools from "@/components/PublicTools";
import { AuthCta } from "@/components/AuthCta";

// Rendered on each request so the list is fresh; the client then keeps it live.
export const dynamic = "force-dynamic";

export default async function Home() {
  const tools = await preloadQuery(api.tools.publicList, {});
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center justify-between gap-3 px-6 py-5">
        <Logo />
        <AuthCta />
      </header>

      <main className="mx-auto flex w-full max-w-[1200px] flex-1 flex-wrap items-start gap-12 px-6 pb-16 pt-8">
        <section className="flex flex-[1_1_380px] flex-col gap-5 pt-6">
          <h1 className="font-display text-5xl font-bold leading-[1.03] tracking-tight sm:text-[56px]">
            Borrow what you need.
            <br />
            <span className="text-brand">Lend what you don&apos;t.</span>
          </h1>
          <p className="max-w-[460px] text-lg leading-relaxed text-muted">
            The drill you use twice a year is the one your neighbour needs this weekend. List it, lend it, and get it
            back on time with friendly reminders.
          </p>
          <div>
            <AuthCta large />
          </div>
          <ol className="flex flex-wrap gap-x-6 gap-y-2 pt-2 text-sm text-muted">
            <li><b className="text-ink">1</b> List a tool</li>
            <li><b className="text-ink">2</b> A neighbour asks for dates</li>
            <li><b className="text-ink">3</b> You approve, and it comes back</li>
          </ol>
        </section>

        <PublicTools preloaded={tools} />
      </main>

      <footer className="border-t border-line py-6 text-center text-xs text-muted">
        LendLoop is a demo project. Owners stay private until you sign in and a loan is agreed.
      </footer>
    </div>
  );
}
