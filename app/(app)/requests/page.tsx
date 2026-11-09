"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button, Card, EmptyState, Notice, PageTitle, Pill, Spinner, Timeline, cx, type Tone } from "@/components/ui";
import { daysInclusive, errorMessage, formatDay, formatRange, timeAgo } from "@/lib/format";

type Incoming = NonNullable<ReturnType<typeof useQuery<typeof api.loans.incoming>>>;
type LoanView = Incoming["out"][number];
type PendingView = Incoming["pending"][number];

const TABS = [
  { id: "incoming", label: "Incoming requests" },
  { id: "mine", label: "My requests" },
  { id: "out", label: "Lent out" },
  { id: "history", label: "History" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function RequestsPage() {
  return (
    <Suspense fallback={<p className="flex items-center gap-2 text-muted"><Spinner /> Loading…</p>}>
      <Requests />
    </Suspense>
  );
}

function Requests() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "incoming") as TabId;
  const incoming = useQuery(api.loans.incoming);
  const mine = useQuery(api.loans.mine);

  const count: Record<TabId, number | undefined> = {
    incoming: incoming?.pending.length,
    mine: mine?.filter((l) => l.status === "pending" || l.status === "approved").length,
    out: incoming?.out.length,
    history: undefined,
  };

  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="Requests" />
      <div role="tablist" aria-label="Requests" className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => router.replace(t.id === "incoming" ? "/requests" : `/requests?tab=${t.id}`, { scroll: false })}
            className={cx(
              "-mb-px min-h-11 border-b-[3px] px-4 text-sm font-semibold",
              tab === t.id ? "border-brand text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {t.label}
            {count[t.id] ? <span className="ml-1.5 text-muted">· {count[t.id]}</span> : null}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {incoming === undefined || mine === undefined ? (
          <p className="flex items-center gap-2 text-muted"><Spinner /> Loading…</p>
        ) : tab === "incoming" ? (
          incoming.pending.length === 0 ? (
            <EmptyState title="No requests waiting">When a neighbour asks to borrow one of your tools, it appears here.</EmptyState>
          ) : (
            <Grid>{incoming.pending.map((l) => <PendingCard key={l._id} loan={l} />)}</Grid>
          )
        ) : tab === "mine" ? (
          mine.length === 0 ? (
            <EmptyState title="You haven’t asked to borrow anything">Browse the Tools page to find something.</EmptyState>
          ) : (
            <Grid>{mine.map((l) => <MyRequestCard key={l._id} loan={l} />)}</Grid>
          )
        ) : tab === "out" ? (
          incoming.out.length === 0 ? (
            <EmptyState title="Nothing lent out">Approved loans of your tools show here until they come back.</EmptyState>
          ) : (
            <Grid>{incoming.out.map((l) => <OutCard key={l._id} loan={l} />)}</Grid>
          )
        ) : incoming.history.length === 0 ? (
          <EmptyState title="No history yet" />
        ) : (
          <Grid>{incoming.history.map((l) => <HistoryCard key={l._id} loan={l} />)}</Grid>
        )}
      </div>
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-4">{children}</div>;
}

function useAction<A>(fn: (args: A) => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(args: A) {
    setBusy(true);
    setError(null);
    try {
      await fn(args);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Waiting for an answer", tone: "blue" },
  approved: { label: "Approved", tone: "green" },
  declined: { label: "Declined", tone: "grey" },
  cancelled: { label: "Cancelled", tone: "grey" },
  returned: { label: "Returned", tone: "grey" },
};

function Dates({ loan }: { loan: LoanView }) {
  const n = daysInclusive(loan.startDate, loan.endDate);
  return (
    <p className="text-[13px] text-muted">
      {formatRange(loan.startDate, loan.endDate)} · {n} day{n === 1 ? "" : "s"} · asked {timeAgo(loan._creationTime)}
    </p>
  );
}

function PendingCard({ loan }: { loan: PendingView }) {
  const approve = useAction(useMutation(api.loans.approve));
  const decline = useAction(useMutation(api.loans.decline));
  const error = approve.error ?? decline.error;
  return (
    <Card className="flex flex-col gap-3">
      <Pill tone={loan.expired ? "grey" : "blue"}>{loan.expired ? "Dates have passed" : "Waiting for you"}</Pill>
      <div>
        <p className="text-[17px] font-bold">{loan.otherFirstName} wants your {loan.toolName}</p>
        <Dates loan={loan} />
      </div>
      {loan.note ? <p className="text-sm italic text-ink-2">“{loan.note}”</p> : null}
      {loan.datesTaken ? (
        <Notice tone="amber">You already approved someone else for some of these dates. Decline this one.</Notice>
      ) : loan.competing > 0 ? (
        <Notice tone="amber">
          {loan.competing} other request{loan.competing > 1 ? "s" : ""} overlap these dates. Approving this one declines
          {loan.competing > 1 ? " them" : " it"} automatically, and they’re told by email.
        </Notice>
      ) : null}
      {error ? <Notice tone="red" role="alert">{error}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <Button busy={approve.busy} disabled={decline.busy || loan.datesTaken || loan.expired} onClick={() => approve.run({ loanId: loan._id as Id<"loans"> })}>
          Approve
        </Button>
        <Button variant="secondary" busy={decline.busy} disabled={approve.busy} onClick={() => decline.run({ loanId: loan._id as Id<"loans"> })}>
          Decline
        </Button>
      </div>
      <Activity loan={loan} />
    </Card>
  );
}

function OutCard({ loan }: { loan: LoanView }) {
  const returned = useAction(useMutation(api.loans.markReturned));
  return (
    <Card className="flex flex-col gap-3">
      {loan.overdue ? (
        <Pill tone="red">Overdue since {formatDay(loan.endDate)}</Pill>
      ) : loan.started ? (
        <Pill tone="green">On loan</Pill>
      ) : (
        <Pill tone="violet">Starts {formatDay(loan.startDate)}</Pill>
      )}
      <div>
        <p className="text-[17px] font-bold">{loan.toolName} · with {loan.otherFirstName}</p>
        <p className="text-[13px] text-muted">{formatRange(loan.startDate, loan.endDate)} · due back {formatDay(loan.endDate)}</p>
      </div>
      {loan.overdue ? <p className="text-[13px] text-muted">LendLoop emails {loan.otherFirstName} a reminder every morning until it’s back.</p> : null}
      {returned.error ? <Notice tone="red" role="alert">{returned.error}</Notice> : null}
      <div>
        <Button busy={returned.busy} disabled={!loan.started} onClick={() => returned.run({ loanId: loan._id as Id<"loans"> })}>
          Mark as returned
        </Button>
      </div>
      <Activity loan={loan} />
    </Card>
  );
}

function MyRequestCard({ loan }: { loan: LoanView }) {
  const cancel = useAction(useMutation(api.loans.cancel));
  const s = loan.overdue ? { label: `Overdue: due back ${formatDay(loan.endDate)}`, tone: "red" as Tone } : STATUS[loan.status];
  return (
    <Card className="flex flex-col gap-3">
      <Pill tone={s.tone}>{s.label}</Pill>
      <div>
        <p className="text-[17px] font-bold">{loan.toolName} from {loan.otherFirstName}</p>
        <Dates loan={loan} />
      </div>
      {loan.status === "approved" && !loan.overdue ? (
        <p className="text-[13px] text-muted">Please return it by {formatDay(loan.endDate)}.</p>
      ) : null}
      {cancel.error ? <Notice tone="red" role="alert">{cancel.error}</Notice> : null}
      {loan.status === "pending" ? (
        <div>
          <Button variant="secondary" busy={cancel.busy} onClick={() => cancel.run({ loanId: loan._id as Id<"loans"> })}>
            Cancel request
          </Button>
        </div>
      ) : null}
      <Activity loan={loan} />
    </Card>
  );
}

function HistoryCard({ loan }: { loan: LoanView }) {
  const s = STATUS[loan.status];
  return (
    <Card className="flex flex-col gap-3 bg-soft">
      <Pill tone={s.tone}>{s.label}</Pill>
      <div>
        <p className="font-bold">{loan.toolName} · {loan.otherFirstName}</p>
        <p className="text-[13px] text-muted">{formatRange(loan.startDate, loan.endDate)}</p>
      </div>
      <Activity loan={loan} />
    </Card>
  );
}

function Activity({ loan }: { loan: LoanView }) {
  if (loan.activity.length === 0) return null;
  return (
    <details className="group" open={loan.activity.some((a) => a.tone !== "app")}>
      <summary className="cursor-pointer text-[13px] font-semibold text-muted hover:text-ink">Activity</summary>
      <div className="mt-2.5">
        <Timeline items={loan.activity} />
      </div>
    </details>
  );
}
