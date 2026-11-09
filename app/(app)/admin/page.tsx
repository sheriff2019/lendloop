"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button, Card, EmptyState, Field, Notice, PageTitle, Pill, Spinner, cx, inputClass } from "@/components/ui";
import { errorMessage, formatRange, timeAgo } from "@/lib/format";

/**
 * Admin page. The menu link only shows for admins, but that is cosmetic: every
 * query below calls requireAdmin() in Convex and refuses anyone else.
 */
export default function AdminPage() {
  const me = useQuery(api.users.me);
  if (me === undefined) return <p className="flex items-center gap-2 text-muted"><Spinner /> Loading…</p>;
  if (me?.role !== "admin") {
    return <EmptyState title="Admins only">This page is for LendLoop admins.</EmptyState>;
  }
  return <Admin />;
}

function Admin() {
  const overview = useQuery(api.admin.overview);
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="Admin" />
      {overview === undefined ? (
        <p className="flex items-center gap-2 text-muted"><Spinner /> Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
            <Kpi label="Active loans" value={overview.counts.active} />
            <Kpi label="Overdue" value={overview.counts.overdue} alarm={overview.counts.overdue > 0} />
            <Kpi label="Requests waiting" value={overview.counts.pending} />
            <Kpi label="Automation problems" value={overview.counts.failures} alarm={overview.counts.failures > 0} />
          </div>
          {overview.counts.retrying > 0 ? (
            <Notice tone="amber">{overview.counts.retrying} notification{overview.counts.retrying > 1 ? "s are" : " is"} being retried (n8n did not answer).</Notice>
          ) : null}
          <Failures failures={overview.failures} />
        </>
      )}
      <div className="flex flex-wrap items-start gap-5">
        <Loans />
        <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-5">
          <Lenders />
          <Listings />
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, alarm }: { label: string; value: number; alarm?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-line bg-surface px-4 py-3.5">
      <span className="text-[13px] text-muted">{label}</span>
      <b className={cx("font-display text-[26px]", alarm && "text-red")}>{value}</b>
    </div>
  );
}

type Failure = NonNullable<ReturnType<typeof useQuery<typeof api.admin.overview>>>["failures"][number];

function Failures({ failures }: { failures: Failure[] }) {
  const resolve = useMutation(api.admin.resolveFailure);
  const retry = useMutation(api.admin.retryDelivery);
  const [error, setError] = useState<string | null>(null);
  if (failures.length === 0) return null;
  return (
    <section aria-labelledby="failures-title" className="flex flex-col gap-2">
      <h2 id="failures-title" className="font-display text-lg font-semibold">Automation problems</h2>
      {error ? <Notice tone="red" role="alert">{error}</Notice> : null}
      {failures.map((f) => (
        <div key={f._id} role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[#efc2bc] bg-red-soft px-3.5 py-3 text-[13.5px] text-[#5e160f]">
          <span className="min-w-0">
            <b>{f.workflow}</b>
            {f.node ? <> · step “{f.node}”</> : null} · {timeAgo(f.at)}
            <br />
            {f.message}
            {f.executionId ? <span className="text-[#7a2a20]"> (n8n execution #{f.executionId})</span> : null}
          </span>
          <span className="flex gap-2">
            {f.outboxId ? (
              <Button size="sm" variant="secondary" onClick={() => retry({ failureId: f._id }).catch((e) => setError(errorMessage(e)))}>
                Retry delivery
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => resolve({ failureId: f._id }).catch((e) => setError(errorMessage(e)))}>
              Mark as handled
            </Button>
          </span>
        </div>
      ))}
    </section>
  );
}

const STATUS_TONE = { pending: "blue", approved: "green", declined: "grey", cancelled: "grey", returned: "grey" } as const;

function Loans() {
  const loans = useQuery(api.admin.loans);
  return (
    <Card className="min-w-0 flex-[999_1_600px]">
      <h2 className="mb-3 font-display text-lg font-semibold">All loans</h2>
      {loans === undefined ? (
        <Spinner />
      ) : loans.length === 0 ? (
        <p className="text-sm text-muted">No loans yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-2.5 py-2">Tool</th>
                <th className="px-2.5 py-2">Owner</th>
                <th className="px-2.5 py-2">Borrower</th>
                <th className="px-2.5 py-2">Dates</th>
                <th className="px-2.5 py-2">Status</th>
                <th className="px-2.5 py-2">Last automation</th>
              </tr>
            </thead>
            <tbody>
              {loans.map((l) => (
                <tr key={l._id} className="border-b border-line-2 align-top">
                  <td className="px-2.5 py-2.5">{l.toolName}</td>
                  <td className="whitespace-nowrap px-2.5 py-2.5">{l.ownerName}</td>
                  <td className="whitespace-nowrap px-2.5 py-2.5">{l.borrowerName}</td>
                  <td className="whitespace-nowrap px-2.5 py-2.5">{formatRange(l.startDate, l.endDate)}</td>
                  <td className="px-2.5 py-2.5">
                    {l.overdue ? <Pill tone="red">Overdue</Pill> : <Pill tone={STATUS_TONE[l.status]}>{l.status}</Pill>}
                  </td>
                  <td className={cx("px-2.5 py-2.5 text-[13px]", l.lastAutomation?.tone === "warn" ? "font-semibold text-red" : "text-muted")}>
                    {l.lastAutomation ? <>{l.lastAutomation.text} · {timeAgo(l.lastAutomation.at)}</> : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Lenders() {
  const lenders = useQuery(api.admin.lenders);
  const setTrusted = useMutation(api.admin.setTrusted);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="font-display text-lg font-semibold">Lenders</h2>
      {error ? <Notice tone="red" role="alert">{error}</Notice> : null}
      {lenders === undefined ? (
        <Spinner />
      ) : (
        <ul className="flex flex-col divide-y divide-line-2">
          {lenders.map((u) => (
            <li key={u._id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 text-sm">
                <b>{u.name}</b>
                {u.role === "admin" ? <span className="ml-1.5 text-xs font-bold text-muted">ADMIN</span> : null}
                <br />
                <span className="text-[13px] text-muted">{u.tools} tool{u.tools === 1 ? "" : "s"} · {u.loansGiven} returned loan{u.loansGiven === 1 ? "" : "s"}</span>
              </span>
              <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-[13px] font-semibold">
                <input
                  type="checkbox"
                  role="switch"
                  className="size-[18px] accent-[var(--color-violet)]"
                  checked={u.trustedLender}
                  onChange={(e) => setTrusted({ userId: u._id, trusted: e.target.checked }).catch((err) => setError(errorMessage(err)))}
                />
                Trusted Lender
              </label>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Listings() {
  const listings = useQuery(api.admin.listings);
  const remove = useMutation(api.admin.removeListing);
  const [removing, setRemoving] = useState<Id<"tools"> | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (!removing) return;
    setBusy(true);
    setError(null);
    try {
      await remove({ toolId: removing, reason });
      setRemoving(null);
      setReason("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="font-display text-lg font-semibold">Listings</h2>
      <p className="text-[13px] text-muted">Removing hides a listing, declines its waiting requests (those neighbours are told) and keeps it on record.</p>
      {listings === undefined ? (
        <Spinner />
      ) : listings.length === 0 ? (
        <p className="text-sm text-muted">No listings.</p>
      ) : (
        <ul className="flex max-h-[420px] flex-col divide-y divide-line-2 overflow-y-auto">
          {listings.map((t) => (
            <li key={t._id} className="flex flex-col gap-2 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 text-sm">
                  <b>{t.name}</b> <span className="text-muted">· {t.category} · by {t.ownerName}</span>
                </span>
                {removing !== t._id ? (
                  <Button size="sm" variant="danger" onClick={() => { setRemoving(t._id); setReason(""); setError(null); }}>
                    Remove…
                  </Button>
                ) : null}
              </div>
              {removing === t._id ? (
                <form onSubmit={confirm} className="flex flex-col gap-2 rounded-lg bg-soft p-3">
                  <Field label="Reason (kept on record)" htmlFor={`reason-${t._id}`}>
                    <input id={`reason-${t._id}`} className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Not a tool / duplicate listing" maxLength={200} autoFocus />
                  </Field>
                  {error ? <Notice tone="red" role="alert">{error}</Notice> : null}
                  <div className="flex gap-2">
                    <Button size="sm" variant="danger" type="submit" busy={busy} disabled={reason.trim().length < 3}>Remove listing</Button>
                    <Button size="sm" variant="ghost" type="button" onClick={() => setRemoving(null)}>Cancel</Button>
                  </div>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
