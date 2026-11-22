"use client";

import { Fragment, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { JournalView } from "@/core/dashboard/dashboard.queries";
import { formatMoney } from "@/lib/money";
import { Badge, cn } from "./ui";

const KIND_TONE = { payment: "brand", refund: "warn" } as const;

export function LedgerTable({ rows, currency }: { rows: JournalView[]; currency: string }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(rows.slice(0, 1).map((r) => r.id)));
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-panel">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-faint">
            <th className="w-8 px-3 py-3" />
            <th className="px-3 py-3 font-medium">Posted</th>
            <th className="px-3 py-3 font-medium">Description</th>
            <th className="px-3 py-3 font-medium">Type</th>
            <th className="px-3 py-3 font-medium">External ref</th>
            <th className="px-3 py-3 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((j) => {
            const isOpen = open.has(j.id);
            const debit = j.lines.filter((l) => l.direction === "DEBIT").reduce((s, l) => s + BigInt(l.amount), 0n);
            const credit = j.lines.filter((l) => l.direction === "CREDIT").reduce((s, l) => s + BigInt(l.amount), 0n);
            return (
              <Fragment key={j.id}>
                <tr
                  className={cn("cursor-pointer border-b border-line/60 transition hover:bg-panel-2/60", isOpen && "bg-panel-2/40")}
                  onClick={() => toggle(j.id)}
                  aria-expanded={isOpen}
                >
                  <td className="px-3 py-3 text-ink-faint">
                    <ChevronRight className={cn("h-4 w-4 transition", isOpen && "rotate-90 text-brand")} />
                  </td>
                  <td className="num whitespace-nowrap px-3 py-3 text-xs text-ink-dim">
                    {new Date(j.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                  </td>
                  <td className="max-w-[320px] truncate px-3 py-3">{j.description}</td>
                  <td className="px-3 py-3">
                    <Badge tone={KIND_TONE[j.kind as keyof typeof KIND_TONE] ?? "muted"}>{j.kind}</Badge>
                    <span className="ml-2 text-[11px] text-ink-faint">{j.source}</span>
                  </td>
                  <td className="num px-3 py-3 text-xs text-ink-dim">{j.externalRefId ?? "—"}</td>
                  <td className={cn("num whitespace-nowrap px-3 py-3 text-right", j.kind === "refund" && "text-warn")}>
                    {j.kind === "refund" ? "−" : ""}
                    {formatMoney(j.totalCents, currency)}
                  </td>
                </tr>
                {isOpen ? (
                  <tr className="border-b border-line/60 bg-canvas/40">
                    <td />
                    <td colSpan={5} className="px-3 pb-4 pt-2">
                      <div className="mb-2 flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-ink-faint">
                        <span>
                          journal <span className="num text-ink-dim">{j.id}</span>
                        </span>
                        <span>
                          idempotency_key <span className="num text-ink-dim">{j.idempotencyKey}</span>
                        </span>
                        <span>
                          status <span className="text-ok">{j.status}</span>
                        </span>
                      </div>
                      <table className="w-full max-w-2xl text-xs">
                        <thead>
                          <tr className="text-left text-ink-faint">
                            <th className="py-1 font-medium">Account</th>
                            <th className="py-1 text-right font-medium">Debit</th>
                            <th className="py-1 text-right font-medium">Credit</th>
                          </tr>
                        </thead>
                        <tbody className="num">
                          {j.lines.map((l) => (
                            <tr key={l.id} className="border-t border-line/40">
                              <td className={cn("py-1.5", l.direction === "CREDIT" && "pl-6")}>
                                <span className="text-ink">{l.accountCode}</span>
                                <span className="ml-2 font-sans text-ink-faint">{l.accountName}</span>
                              </td>
                              <td className="py-1.5 text-right">{l.direction === "DEBIT" ? formatMoney(l.amount, currency) : ""}</td>
                              <td className="py-1.5 text-right">{l.direction === "CREDIT" ? formatMoney(l.amount, currency) : ""}</td>
                            </tr>
                          ))}
                          <tr className="border-t border-line text-ink-dim">
                            <td className="py-1.5 font-sans">
                              Σ {debit === credit ? <span className="text-ok">balanced</span> : <span className="text-bad">unbalanced</span>}
                            </td>
                            <td className="py-1.5 text-right">{formatMoney(debit, currency)}</td>
                            <td className="py-1.5 text-right">{formatMoney(credit, currency)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
