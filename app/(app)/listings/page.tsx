"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { CATEGORIES, CONDITIONS, LIMITS, type Category, type Condition } from "@/convex/lib/domain";
import { Button, EmptyState, Field, Notice, PageTitle, Pill, Spinner, cx, inputClass } from "@/components/ui";
import { errorMessage, formatDay } from "@/lib/format";

type Listing = NonNullable<ReturnType<typeof useQuery<typeof api.tools.mine>>>[number];
type Draft = { name: string; category: Category; condition: Condition; description: string };
const EMPTY: Draft = { name: "", category: "Power tools", condition: "Good", description: "" };

export default function ListingsPage() {
  const mine = useQuery(api.tools.mine);
  const [editing, setEditing] = useState<Listing | null>(null);

  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="My listings" />
      <div className="flex flex-wrap items-start gap-6">
        <section aria-label="Your tools" className="flex min-w-0 flex-[999_1_560px] flex-col gap-3">
          <p className="text-sm text-muted">Only you can edit or delete these.</p>
          {mine === undefined ? (
            <p className="flex items-center gap-2 text-muted"><Spinner /> Loading…</p>
          ) : mine.length === 0 ? (
            <EmptyState title="You haven’t listed anything yet">Use the form to lend your first tool.</EmptyState>
          ) : (
            <ul className="overflow-hidden rounded-[14px] border border-line bg-surface">
              {mine.map((t) => (
                <ListingRow key={t._id} tool={t} onEdit={() => setEditing(t)} isEditing={editing?._id === t._id} />
              ))}
            </ul>
          )}
          <p className="text-[13px] text-muted">
            A tool that is lent out (or promised) can’t be deleted until it’s returned. Deleting declines any requests
            still waiting, and those neighbours are told.
          </p>
        </section>

        <aside className="w-full flex-[1_1_340px] lg:sticky lg:top-4">
          <ToolForm
            key={editing?._id ?? "new"}
            editing={editing}
            onDone={() => setEditing(null)}
          />
        </aside>
      </div>
    </div>
  );
}

function ListingRow({ tool, onEdit, isEditing }: { tool: Listing; onEdit: () => void; isEditing: boolean }) {
  const remove = useMutation(api.tools.remove);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doRemove() {
    setBusy(true);
    setError(null);
    try {
      await remove({ toolId: tool._id });
    } catch (e) {
      setError(errorMessage(e));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={cx("flex flex-col gap-2 border-b border-line-2 p-4 last:border-b-0", isEditing && "bg-brand-soft/40")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold">{tool.name}</p>
          <p className="text-[13px] text-muted">{tool.category} · {tool.condition}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {tool.onLoanUntil ? (
            <Pill tone={tool.overdue ? "red" : "amber"}>
              {tool.overdue ? `Overdue since ${formatDay(tool.onLoanUntil)}` : `On loan until ${formatDay(tool.onLoanUntil)}`}
            </Pill>
          ) : tool.pendingRequests > 0 ? (
            <Link href="/requests"><Pill tone="blue">{tool.pendingRequests} request{tool.pendingRequests > 1 ? "s" : ""} waiting</Pill></Link>
          ) : (
            <Pill tone="green">Available</Pill>
          )}
          <Button size="sm" variant="secondary" onClick={onEdit}>Edit</Button>
          {confirming ? (
            <>
              <Button size="sm" variant="danger" busy={busy} onClick={doRemove}>Yes, delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
            </>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setConfirming(true)} disabled={tool.hasApprovedLoan} title={tool.hasApprovedLoan ? "Lent out or promised — can’t delete yet" : undefined}>
              Delete
            </Button>
          )}
        </div>
      </div>
      {error ? <Notice tone="red" role="alert">{error}</Notice> : null}
    </li>
  );
}

function ToolForm({ editing, onDone }: { editing: Listing | null; onDone: () => void }) {
  const create = useMutation(api.tools.create);
  const update = useMutation(api.tools.update);
  const [draft, setDraft] = useState<Draft>(
    editing ? { name: editing.name, category: editing.category, condition: editing.condition, description: editing.description } : EMPTY,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const name = draft.name.trim();
    if (name.length < LIMITS.nameMin || name.length > LIMITS.nameMax) {
      return setError(`Name must be ${LIMITS.nameMin}–${LIMITS.nameMax} characters.`);
    }
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await update({ toolId: editing._id as Id<"tools">, ...draft });
        onDone();
      } else {
        await create(draft);
        setSaved(name);
        setDraft(EMPTY);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3.5 rounded-[14px] border border-line bg-surface p-5" aria-labelledby="form-title">
      <h2 id="form-title" className="font-display text-[21px] font-bold">{editing ? `Edit “${editing.name}”` : "List a tool"}</h2>
      <Field label="Name" htmlFor="name">
        <input id="name" className={inputClass} value={draft.name} maxLength={LIMITS.nameMax} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Circular saw" required />
      </Field>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Category" htmlFor="category">
          <select id="category" className={inputClass} value={draft.category} onChange={(e) => set("category", e.target.value as Category)}>
            {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Condition" htmlFor="condition">
          <select id="condition" className={inputClass} value={draft.condition} onChange={(e) => set("condition", e.target.value as Condition)}>
            {CONDITIONS.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Short description" htmlFor="description" hint={`${draft.description.length} / ${LIMITS.descriptionMax}`}>
        <textarea id="description" rows={3} maxLength={LIMITS.descriptionMax} className={cx(inputClass, "resize-y")} value={draft.description} onChange={(e) => set("description", e.target.value)} placeholder="What’s included, anything a borrower should know" />
      </Field>
      {error ? <Notice tone="red" role="alert">{error}</Notice> : null}
      {saved && !editing ? <Notice tone="green" role="status">“{saved}” is listed. Neighbours can ask to borrow it now.</Notice> : null}
      <div className="flex gap-2">
        <Button type="submit" busy={busy}>{editing ? "Save changes" : "Publish listing"}</Button>
        {editing ? <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button> : null}
      </div>
    </form>
  );
}
