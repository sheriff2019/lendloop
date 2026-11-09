import type { ButtonHTMLAttributes, ReactNode } from "react";
import { timeAgo } from "@/lib/format";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "md" | "sm";
  busy?: boolean;
};

export function Button({ variant = "primary", size = "md", busy, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        size === "md" ? "min-h-11 px-[18px] text-[15px]" : "min-h-9 px-3 text-[13px]",
        variant === "primary" && "bg-brand text-white hover:bg-brand-dark",
        variant === "secondary" && "border border-[#d5d5cc] bg-surface text-ink hover:bg-soft",
        variant === "danger" && "border border-[#efc2bc] bg-surface text-red hover:bg-red-soft",
        variant === "ghost" && "text-ink-2 hover:bg-chip",
        className,
      )}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx("inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent", className)}
    />
  );
}

const TONES = {
  green: "bg-brand-soft text-brand-dark",
  amber: "bg-amber-soft text-amber",
  blue: "bg-blue-soft text-blue",
  red: "bg-red-soft text-red",
  grey: "bg-chip text-ink-2",
  violet: "bg-violet-soft text-violet",
} as const;
export type Tone = keyof typeof TONES;

export function Pill({ tone = "grey", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex w-fit items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-bold", TONES[tone], className)}>
      {children}
    </span>
  );
}

export function TrustedBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-violet-soft px-1.5 py-0.5 text-[11.5px] font-bold text-violet"
      title="Marked as a Trusted Lender by a LendLoop admin"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
        <path d="M20 6 9 17l-5-5" />
      </svg>
      Trusted Lender
    </span>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-[14px] border border-line bg-surface p-5", className)}>{children}</div>;
}

export function Notice({ tone = "amber", children, role }: { tone?: "amber" | "red" | "green" | "blue"; children: ReactNode; role?: "alert" | "status" }) {
  const styles = {
    amber: "bg-amber-soft text-amber-ink",
    red: "bg-red-soft text-[#5e160f] border border-[#efc2bc]",
    green: "bg-brand-soft text-brand-dark",
    blue: "bg-blue-soft text-blue",
  }[tone];
  return (
    <div role={role} className={cx("rounded-[10px] px-3 py-2.5 text-[13.5px] leading-snug", styles)}>
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-[14px] border border-dashed border-[#d5d5cc] bg-soft px-6 py-10 text-center">
      <p className="font-display text-lg font-semibold">{title}</p>
      {children ? <div className="mt-1.5 text-sm text-muted">{children}</div> : null}
    </div>
  );
}

export function PageTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <h1 className="font-display text-[28px] font-bold leading-tight">{title}</h1>
      {children}
    </div>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2.5", className)}>
      <svg width="28" height="28" viewBox="0 0 30 30" aria-hidden="true">
        <circle cx="11" cy="15" r="8" fill="none" stroke="var(--color-brand)" strokeWidth="3" />
        <circle cx="19" cy="15" r="8" fill="none" stroke="var(--color-ink)" strokeWidth="3" />
      </svg>
      <span className="font-display text-xl font-bold tracking-tight">LendLoop</span>
    </span>
  );
}

export type ActivityItem = { at: number; text: string; tone: "app" | "auto" | "warn" };

/** A loan's history: people's actions (blue), automations (amber), problems (red). */
export function Timeline({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) return null;
  return (
    <ol className="ml-1 flex flex-col gap-2 border-l-2 border-line pl-4" aria-label="Activity">
      {items.map((item, i) => (
        <li key={`${item.at}-${i}`} className="relative text-[13px] leading-snug">
          <span
            aria-hidden="true"
            className={cx(
              "absolute -left-[21px] top-[5px] size-2.5 rounded-full",
              item.tone === "app" && "bg-blue",
              item.tone === "auto" && "bg-[#c9a15a]",
              item.tone === "warn" && "bg-red",
            )}
          />
          <span className={cx(item.tone === "warn" && "font-semibold text-red")}>{item.text}</span>
          <span className="text-muted"> · {timeAgo(item.at)}</span>
        </li>
      ))}
    </ol>
  );
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-semibold text-ink-2">
        {label}
      </label>
      {children}
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </div>
  );
}

export const inputClass =
  "min-h-11 w-full rounded-[9px] border border-[#cfcfc6] bg-surface px-3 py-2 text-[15px] text-ink placeholder:text-[#8a8f99] focus:border-brand focus:outline-none";
