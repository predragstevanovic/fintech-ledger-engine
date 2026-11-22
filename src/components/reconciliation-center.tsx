"use client";

import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, HelpCircle, Loader2, Play, SearchX, Upload } from "lucide-react";
import { formatMoney } from "@/lib/money";
import { Badge, Button, Card, CardTitle, cn } from "./ui";

type Row = {
  id: string;
  status: "MATCHED" | "DISCREPANCY" | "MISSING_IN_LEDGER" | "MISSING_IN_PSP";
  pspTransactionId: string;
  journalEntryId: string | null;
  pspAmount: string | null;
  ledgerAmount: string | null;
  delta: string | null;
  notes: string | null;
};
type Snapshot = {
  reconciledAt: string | null;
  summary: Record<Row["status"], number> & { total: number };
  rows: Row[];
};

const STATUS = {
  MATCHED: { tone: "ok", icon: CheckCircle2, label: "Matched" },
  DISCREPANCY: { tone: "bad", icon: AlertTriangle, label: "Discrepancy" },
  MISSING_IN_LEDGER: { tone: "bad", icon: SearchX, label: "Missing in ledger" },
  MISSING_IN_PSP: { tone: "warn", icon: HelpCircle, label: "Missing in PSP" },
} as const;

export function ReconciliationCenter({ tenantId, currency, initial }: { tenantId: string; currency: string; initial: Snapshot }) {
  const [csv, setCsv] = useState("");
  const [snap, setSnap] = useState<Snapshot>(initial);
  const [busy, setBusy] = useState<"gen" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ms, setMs] = useState<number | null>(null);
  const [filter, setFilter] = useState<"ALL" | "ISSUES">("ISSUES");
  const fileRef = useRef<HTMLInputElement>(null);

  async function call(body: object) {
    const res = await fetch("/api/v1/reconcile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: tenantId, ...body }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail ?? json.title ?? "Request failed");
    return json;
  }

  async function generate() {
    setBusy("gen");
    setError(null);
    try {
      setCsv((await call({ action: "generate" })).csv);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function run() {
    setBusy("run");
    setError(null);
    try {
      const json = await call({ action: "run", statement: csv });
      setSnap(json);
      setMs(json.processing_ms);
      setFilter("ISSUES");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const lines = csv ? csv.split("\n").length - 1 : 0;
  const issues = snap.rows.filter((r) => r.status !== "MATCHED");
  const shown = filter === "ISSUES" ? issues : snap.rows;

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-2">
        <CardTitle hint={lines ? `${lines} lines` : "CSV: psp_transaction_id,amount_cents"}>1 · PSP settlement statement</CardTitle>
        <div className="mb-3 flex flex-wrap gap-2">
          <Button onClick={generate} disabled={busy !== null}>
            {busy === "gen" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
            Generate Realistic PSP Statement (with 2 Discrepancies)
          </Button>
          <Button variant="ghost" onClick={() => fileRef.current?.click()} disabled={busy !== null}>
            <Upload className="h-4 w-4" /> Upload CSV
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setCsv(await f.text());
              e.target.value = "";
            }}
          />
        </div>
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          spellCheck={false}
          placeholder={"psp_transaction_id,amount_cents\npi_3QxY...,12450"}
          className="num h-72 w-full resize-y rounded-lg border border-line bg-canvas p-3 text-xs text-ink-dim outline-none focus:border-brand/60"
        />
        <Button className="mt-3 w-full" onClick={run} disabled={busy !== null || !csv.trim()}>
          {busy === "run" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Run Reconciliation Engine
        </Button>
        {error ? <p className="mt-3 text-xs text-bad">{error}</p> : null}
      </Card>

      <div className="space-y-6 lg:col-span-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(Object.keys(STATUS) as Row["status"][]).map((s) => {
            const { tone, icon: Icon, label } = STATUS[s];
            return (
              <Card key={s} className="p-4">
                <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                  <Icon className={cn("h-3.5 w-3.5", tone === "ok" ? "text-ok" : tone === "bad" ? "text-bad" : "text-warn")} />
                  {label}
                </div>
                <div className="num mt-1 text-2xl font-semibold">{snap.summary[s]}</div>
              </Card>
            );
          })}
        </div>

        <Card className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
            <div>
              <h2 className="text-sm font-medium">2 · Reconciliation result</h2>
              <p className="text-xs text-ink-faint">
                {snap.reconciledAt
                  ? `Last run ${new Date(snap.reconciledAt).toLocaleString("en-GB")} · ${snap.summary.total} records${ms !== null ? ` · ${ms} ms` : ""}`
                  : "No reconciliation has been run yet for this tenant."}
              </p>
            </div>
            <div className="flex rounded-lg border border-line p-0.5 text-xs">
              {(["ISSUES", "ALL"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={cn("rounded-md px-2.5 py-1", filter === f ? "bg-panel-2 text-ink" : "text-ink-dim")}
                >
                  {f === "ISSUES" ? `Issues (${issues.length})` : `All (${snap.rows.length})`}
                </button>
              ))}
            </div>
          </div>
          <div className="max-h-[460px] overflow-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="sticky top-0 bg-panel">
                <tr className="text-left text-[11px] uppercase tracking-wider text-ink-faint">
                  <th className="px-5 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">PSP transaction</th>
                  <th className="px-3 py-2.5 text-right font-medium">PSP</th>
                  <th className="px-3 py-2.5 text-right font-medium">Ledger</th>
                  <th className="px-5 py-2.5 text-right font-medium">Δ</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const { tone, label } = STATUS[r.status];
                  return (
                    <tr key={r.id} className="border-t border-line/60 align-top">
                      <td className="px-5 py-2.5">
                        <Badge tone={tone}>{label}</Badge>
                        {r.notes ? <div className="mt-1 max-w-[220px] text-[11px] text-ink-faint">{r.notes}</div> : null}
                      </td>
                      <td className="num px-3 py-2.5 text-xs text-ink-dim">{r.pspTransactionId}</td>
                      <td className="num px-3 py-2.5 text-right text-xs">{r.pspAmount ? formatMoney(r.pspAmount, currency) : "—"}</td>
                      <td className="num px-3 py-2.5 text-right text-xs">{r.ledgerAmount ? formatMoney(r.ledgerAmount, currency) : "—"}</td>
                      <td className={cn("num px-5 py-2.5 text-right text-xs", r.delta && r.delta !== "0" ? "text-bad" : "text-ink-faint")}>
                        {r.delta ? formatMoney(r.delta, currency) : "—"}
                      </td>
                    </tr>
                  );
                })}
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-10 text-center text-sm text-ink-faint">
                      {snap.rows.length ? "No issues — every line matched." : "Generate a statement and run the engine."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
