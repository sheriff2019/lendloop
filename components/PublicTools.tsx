"use client";

import { usePreloadedQuery, type Preloaded } from "convex/react";
import type { api } from "@/convex/_generated/api";

/** Read-only list for visitors: tool name and category only (that is all the query returns). */
export default function PublicTools({ preloaded }: { preloaded: Preloaded<typeof api.tools.publicList> }) {
  const tools = usePreloadedQuery(preloaded);
  return (
    <section aria-labelledby="available-heading" className="flex-[1_1_440px] overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-4">
        <h2 id="available-heading" className="font-display text-lg font-semibold">
          Tools in the neighbourhood
        </h2>
        <span className="text-[13px] text-muted">{tools.length} listed · read-only</span>
      </div>
      {tools.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-muted">No tools listed yet. Be the first to lend one.</p>
      ) : (
        <ul className="max-h-[480px] overflow-y-auto">
          {tools.map((t, i) => (
            <li key={`${t.name}-${i}`} className="flex items-center justify-between gap-3 border-b border-line-2 px-5 py-3.5 text-[15px] last:border-b-0">
              <span>{t.name}</span>
              <span className="whitespace-nowrap rounded-full bg-chip px-2.5 py-1 text-[12.5px] font-semibold text-ink-2">{t.category}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
