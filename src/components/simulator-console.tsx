"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, ShieldCheck, Timer, Zap } from "lucide-react";
import { formatMoney } from "@/lib/money";
import { Badge, Button, Card, CardTitle, cn } from "./ui";

type LogLine =
  | { type: "start"; runId: string; payments: number; duplicateWebhooks: number }
  | { type: "log"; kind: "payment" | "webhook"; i: number; http: number; result: string; amount?: number; ms: number }
  | {
      type: "summary";
      totalMs: number;
      paymentsPosted: number;
      paymentsFailed: number;
      webhookDeliveries: number;
      webhookJournals: number;
      duplicatesBlocked: number;
      ledgerInBalance: boolean;
      equation: { left: string; right: string };
    }
  | { type: "error"; message: string }
  | { type: "client"; message: string };

type Summary = Extract<LogLine, { type: "summary" }>;

export function SimulatorConsole({ tenantId, currency }: { tenantId: string; currency: string }) {
  const router = useRouter();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => endRef.current?.scrollIntoView({ block: "nearest" }), [lines]);

  async function fire() {
    setRunning(true);
    setLines([]);
    setSummary(null);
    try {
      const res = await fetch("/api/v1/simulator", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenant_id: tenantId }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        setLines([{ type: "error", message: j.detail ?? j.title ?? `HTTP ${res.status}` }]);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        const parsed = parts.filter(Boolean).map((p) => JSON.parse(p) as LogLine);
        setLines((prev) => [...prev, ...parsed]);
        const s = parsed.find((p): p is Summary => p.type === "summary");
        if (s) setSummary(s);
      }
      router.refresh();
    } catch (e) {
      setLines((prev) => [...prev, { type: "error", message: (e as Error).message }]);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6">
        <Card>
          <CardTitle>Scenario</CardTitle>
          <ul className="mb-5 space-y-2 text-sm text-ink-dim">
            <li className="flex gap-2">
              <Zap className="mt-0.5 h-4 w-4 shrink-0 text-brand" /> 25 payments POSTed concurrently to <span className="num text-ink">/api/v1/transactions</span>, each with its own Idempotency-Key.
            </li>
            <li className="flex gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" /> The <em>same</em> HMAC-signed <span className="num text-ink">payment.succeeded</span> webhook delivered 10× in parallel, like a flaky PSP retrying.
            </li>
            <li className="flex gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" /> Expected: 25 + 1 journals posted, 9 duplicates blocked, ledger still in balance.
            </li>
          </ul>
          <Button className="w-full" onClick={fire} disabled={running}>
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            Fire 25 Concurrent Payments + 10 Duplicate Webhooks
          </Button>
        </Card>

        {summary ? (
          <Card>
            <CardTitle hint={<span className="flex items-center gap-1"><Timer className="h-3 w-3" />{summary.totalMs} ms</span>}>Result</CardTitle>
            <dl className="grid grid-cols-2 gap-4 text-sm">
              {[
                ["Payments posted", `${summary.paymentsPosted} / 25`, summary.paymentsPosted === 25],
                ["Payment failures", summary.paymentsFailed, summary.paymentsFailed === 0],
                ["Webhook deliveries", summary.webhookDeliveries, true],
                ["Webhook journals", summary.webhookJournals, summary.webhookJournals === 1],
                ["Duplicates blocked", summary.duplicatesBlocked, summary.duplicatesBlocked === summary.webhookDeliveries - 1],
              ].map(([k, v, ok]) => (
                <div key={String(k)}>
                  <dt className="text-xs text-ink-faint">{k}</dt>
                  <dd className={cn("num mt-0.5 text-lg", ok ? "text-ink" : "text-bad")}>{v}</dd>
                </div>
              ))}
              <div>
                <dt className="text-xs text-ink-faint">Ledger</dt>
                <dd className="mt-1">
                  <Badge tone={summary.ledgerInBalance ? "ok" : "bad"}>{summary.ledgerInBalance ? "IN BALANCE" : "OUT OF BALANCE"}</Badge>
                </dd>
              </div>
            </dl>
            <p className="num mt-4 border-t border-line pt-3 text-[11px] text-ink-faint">
              A+E {formatMoney(summary.equation.left, currency)} = L+R {formatMoney(summary.equation.right, currency)}
            </p>
          </Card>
        ) : null}
      </div>

      <Card className="p-0 lg:col-span-2">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="text-sm font-medium">Live log</span>
          <span className="num text-[11px] text-ink-faint">{lines.filter((l) => l.type === "log").length} / 35 responses</span>
        </div>
        <div className="num h-[520px] overflow-auto bg-canvas/60 px-5 py-3 text-xs leading-6">
          {lines.length === 0 ? <div className="text-ink-faint">$ waiting for chaos…</div> : null}
          {lines.map((l, idx) => (
            <div key={idx}>
              {l.type === "start" ? (
                <span className="text-ink-faint">$ run {l.runId} · {l.payments} payments + {l.duplicateWebhooks} duplicate webhooks fired concurrently</span>
              ) : l.type === "log" ? (
                <span>
                  <span className="text-ink-faint">{l.kind === "payment" ? "POST /transactions" : "POST /webhooks/psp"} </span>
                  <span className="text-ink-dim">#{String(l.i + 1).padStart(2, "0")} </span>
                  <span className={l.http < 300 ? "text-ok" : "text-bad"}>{l.http} </span>
                  <span className={l.result === "POSTED" ? "text-ink" : l.result === "ACCEPTED" ? "text-brand" : "text-warn"}>{l.result}</span>
                  {l.amount !== undefined ? <span className="text-ink-faint"> {formatMoney(BigInt(l.amount), currency)}</span> : null}
                  <span className="text-ink-faint"> · {l.ms} ms</span>
                </span>
              ) : l.type === "summary" ? (
                <span className="text-ok">
                  ✔ done in {l.totalMs} ms — {l.paymentsPosted} payments posted, webhook posted {l.webhookJournals}×, {l.duplicatesBlocked} duplicates blocked, ledger{" "}
                  {l.ledgerInBalance ? "in balance" : "OUT OF BALANCE"}
                </span>
              ) : (
                <span className="text-bad">✘ {"message" in l ? l.message : ""}</span>
              )}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      </Card>
    </div>
  );
}
