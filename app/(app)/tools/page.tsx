"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { CATEGORIES, LIMITS, type Category } from "@/convex/lib/domain";
import { Button, EmptyState, Field, Notice, PageTitle, Pill, Spinner, TrustedBadge, cx, inputClass } from "@/components/ui";
import { addDaysTo, daysInclusive, errorMessage, formatDay, formatRange, todayLocal } from "@/lib/format";

type ToolRow = NonNullable<ReturnType<typeof useQuery<typeof api.tools.list>>>[number];

export default function ToolsPage() {
  const [category, setCategory] = useState<Category | undefined>();
  const [availableOnly, setAvailableOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<Id<"tools"> | null>(null);
  const tools = useQuery(api.tools.list, { category, availableOnly });
  const selected = tools?.find((t) => t._id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="All tools">
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="size-[18px] accent-[var(--color-brand)]"
            checked={availableOnly}
            onChange={(e) => setAvailableOnly(e.target.checked)}
          />
          Available now only
        </label>
      </PageTitle>

      <div role="group" aria-label="Filter by category" className="flex flex-wrap gap-2">
        {[undefined, ...CATEGORIES].map((c) => (
          <button
            key={c ?? "all"}
            type="button"
            aria-pressed={category === c}
            onClick={() => setCategory(c)}
            className={cx(
              "min-h-9 rounded-full border px-3.5 text-[13px] font-semibold",
              category === c ? "border-ink bg-ink text-white" : "border-[#d5d5cc] bg-surface text-ink-2 hover:bg-soft",
            )}
          >
            {c ?? "All"}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <section aria-label="Tools" className="min-w-0 flex-[999_1_560px]">
          {tools === undefined ? (
            <p className="flex items-center gap-2 text-muted"><Spinner /> Loading tools…</p>
          ) : tools.length === 0 ? (
            <EmptyState title="Nothing here yet">
              {category || availableOnly ? "Try another category, or show tools that are out on loan too." : (
                <>No one has listed a tool. <Link className="font-semibold text-brand underline" href="/listings">List the first one</Link>.</>
              )}
            </EmptyState>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3.5">
              {tools.map((t) => (
                <li key={t._id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(t._id)}
                    aria-pressed={selectedId === t._id}
                    className={cx(
                      "flex h-full w-full flex-col gap-2 rounded-xl border bg-surface p-4 text-left hover:border-[#c8c8be]",
                      selectedId === t._id ? "border-2 border-brand p-[15px]" : "border-line",
                    )}
                  >
                    <Status tool={t} />
                    <span className="text-base font-bold">{t.name}</span>
                    <span className="text-[13px] text-muted">{t.category} · {t.condition}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted">
                      {t.isMine ? "Your listing" : <>Lent by {t.ownerFirstName}</>}
                      {t.ownerTrusted && !t.isMine ? <TrustedBadge /> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside aria-label="Tool details" className="w-full flex-[1_1_320px] lg:sticky lg:top-4">
          {selected ? (
            <ToolDetails key={selected._id} tool={selected} />
          ) : (
            <div className="rounded-[14px] border border-dashed border-[#d5d5cc] bg-soft p-6 text-sm text-muted">
              Choose a tool to see its details and ask to borrow it.
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Status({ tool }: { tool: ToolRow }) {
  const a = tool.availability;
  if (a.state === "mine") return <Pill tone="blue">Your listing</Pill>;
  if (a.state === "on_loan") {
    return a.overdue ? <Pill tone="amber">On loan · overdue</Pill> : <Pill tone="amber">On loan until {formatDay(a.until)}</Pill>;
  }
  return <Pill tone="green">Available</Pill>;
}

function ToolDetails({ tool }: { tool: ToolRow }) {
  return (
    <div className="flex flex-col gap-3.5 rounded-[14px] border border-line bg-surface p-5">
      <Status tool={tool} />
      <h2 className="font-display text-[22px] font-bold leading-tight">{tool.name}</h2>
      <p className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted">
        {tool.category} · {tool.condition} condition · {tool.isMine ? "Your listing" : `Lent by ${tool.ownerFirstName}`}
        {tool.ownerTrusted && !tool.isMine ? <TrustedBadge /> : null}
      </p>
      {tool.description ? <p className="text-sm leading-relaxed">{tool.description}</p> : null}
      {tool.isMine ? (
        <Notice tone="blue">This is your tool. Manage it in <Link className="font-semibold underline" href="/listings">My listings</Link>.</Notice>
      ) : (
        <RequestForm tool={tool} />
      )}
    </div>
  );
}

function RequestForm({ tool }: { tool: ToolRow }) {
  const request = useMutation(api.loans.request);
  const today = todayLocal();
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(addDaysTo(today, 2));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // The same rules the server enforces, checked early so people aren't surprised.
  const problem = useMemo(() => {
    if (!start || !end) return "Pick a start and an end date.";
    if (start < today) return "The start date has already passed.";
    if (end < start) return "The end date is before the start date.";
    if (daysInclusive(start, end) > LIMITS.loanMaxDays) return `A loan can be at most ${LIMITS.loanMaxDays} days.`;
    const clash = tool.booked.find((b) => start <= b.end && b.start <= end);
    if (clash) return `Already booked ${formatRange(clash.start, clash.end)}. Pick other dates.`;
    return null;
  }, [start, end, today, tool.booked]);

  if (sent) {
    return (
      <Notice tone="green" role="status">
        Request sent. {tool.ownerFirstName} gets an email and you’ll hear back here and by email.{" "}
        <Link className="font-semibold underline" href="/requests?tab=mine">See my requests</Link>
      </Notice>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await request({ toolId: tool._id, startDate: start, endDate: end, note: note.trim() || undefined });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3.5" noValidate>
      {tool.myOpenRequest ? <Notice tone="blue">You already have a request waiting for this tool.</Notice> : null}
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="From" htmlFor="start">
          <input id="start" type="date" className={inputClass} min={today} value={start} onChange={(e) => setStart(e.target.value)} required />
        </Field>
        <Field label="Until" htmlFor="end">
          <input id="end" type="date" className={inputClass} min={start || today} value={end} onChange={(e) => setEnd(e.target.value)} required />
        </Field>
      </div>
      <Field label={`Note to ${tool.ownerFirstName} (optional)`} htmlFor="note" hint={`${note.length} / ${LIMITS.noteMax}`}>
        <textarea id="note" rows={2} maxLength={LIMITS.noteMax} className={cx(inputClass, "resize-y")} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What it's for, when you'll pick it up…" />
      </Field>
      {tool.booked.length > 0 ? (
        <p className="text-[13px] text-muted">
          Already booked: {tool.booked.map((b) => formatRange(b.start, b.end)).join(", ")}
        </p>
      ) : null}
      {error ?? problem ? (
        <Notice tone={error ? "red" : "amber"} role={error ? "alert" : undefined}>{error ?? problem}</Notice>
      ) : null}
      <Button type="submit" busy={busy} disabled={Boolean(problem)}>
        Send request {start && end && !problem ? `· ${daysInclusive(start, end)} day${daysInclusive(start, end) === 1 ? "" : "s"}` : ""}
      </Button>
    </form>
  );
}
