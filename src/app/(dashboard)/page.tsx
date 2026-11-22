import { CheckCircle2, Landmark, Receipt, ShieldCheck, TrendingUp, Wallet, XCircle } from "lucide-react";
import { getOverview } from "@/core/dashboard/dashboard.queries";
import { resolveActiveTenant } from "@/lib/tenant-context";
import { formatMoney } from "@/lib/money";
import { Badge, Card, CardTitle, PageHeader } from "@/components/ui";
import { RevenueFeesChart, VolumeChart } from "@/components/charts";

const ICONS = { ASSET: Wallet, LIABILITY: Landmark, REVENUE: TrendingUp, EXPENSE: Receipt } as const;
const HINTS = {
  ASSET: "Cash held in escrow / PSP clearing",
  LIABILITY: "Owed to partners (payouts pending)",
  REVENUE: "Gross platform commission",
  EXPENSE: "Card processing costs",
} as const;

export default async function OverviewPage() {
  const { active } = await resolveActiveTenant();
  if (!active) return null;
  const cur = active.settings.currency;
  const ov = await getOverview(active.id);
  const split = active.settings.split;

  return (
    <>
      <PageHeader
        title={active.name}
        subtitle={`${active.settings.industry ?? "Marketplace"} · books in ${cur} · default split ${split.merchantBp / 100}% partner / ${split.platformBp / 100}% platform / ${split.pspFeeBp / 100}% PSP`}
        right={
          ov.equation.inBalance ? (
            <Badge tone="ok" className="px-3 py-1 text-xs">
              <CheckCircle2 className="h-3.5 w-3.5" /> LEDGER IN BALANCE
            </Badge>
          ) : (
            <Badge tone="bad" className="px-3 py-1 text-xs">
              <XCircle className="h-3.5 w-3.5" /> OUT OF BALANCE by {formatMoney(ov.equation.difference, cur)}
            </Badge>
          )
        }
      />

      <Card className="mb-6 flex flex-wrap items-center justify-between gap-4 bg-gradient-to-r from-panel to-panel-2">
        <div className="text-xs uppercase tracking-wider text-ink-faint">Accounting equation</div>
        <div className="num flex flex-wrap items-center gap-3 text-sm">
          <span className="text-ink-dim">Assets + Expenses</span>
          <span className="text-ink">{formatMoney(ov.equation.left, cur)}</span>
          <span className={ov.equation.inBalance ? "text-ok" : "text-bad"}>{ov.equation.inBalance ? "=" : "≠"}</span>
          <span className="text-ink">{formatMoney(ov.equation.right, cur)}</span>
          <span className="text-ink-dim">Liabilities + Revenue</span>
        </div>
      </Card>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {ov.accounts.map((a) => {
          const Icon = ICONS[a.accountType];
          return (
            <Card key={a.id}>
              <div className="mb-3 flex items-center justify-between">
                <span className="num text-[11px] text-ink-faint">{a.code}</span>
                <Icon className="h-4 w-4 text-ink-faint" />
              </div>
              <div className="num text-2xl font-semibold tracking-tight">{formatMoney(a.balance, cur)}</div>
              <div className="mt-1 text-xs text-ink-dim">{a.name}</div>
              <div className="mt-3 flex items-center justify-between text-[11px] text-ink-faint">
                <span>{HINTS[a.accountType]}</span>
                <span className="num">v{a.version}</span>
              </div>
            </Card>
          );
        })}
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle hint="last 30 days">Gross payment volume</CardTitle>
          <VolumeChart data={ov.daily} currency={cur} />
        </Card>
        <Card>
          <CardTitle>Activity</CardTitle>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            {[
              ["Gross volume", formatMoney(ov.kpis.grossVolume, cur)],
              ["Journal entries", ov.kpis.journals.toLocaleString("en-US")],
              ["Payments", ov.kpis.payments.toLocaleString("en-US")],
              ["Refunds (storno)", ov.kpis.refunds.toLocaleString("en-US")],
              ["Ledger lines", ov.kpis.ledgerLines.toLocaleString("en-US")],
              ["Lines per journal", ov.kpis.journals ? (ov.kpis.ledgerLines / ov.kpis.journals).toFixed(1) : "—"],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-ink-faint">{k}</dt>
                <dd className="num mt-0.5 text-ink">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle hint="last 14 days">Platform revenue vs PSP fees</CardTitle>
          <RevenueFeesChart data={ov.daily} currency={cur} />
        </Card>
        <Card>
          <CardTitle>
            <span className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-ok" /> Tenant isolation (RLS)
            </span>
          </CardTitle>
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-ink-dim">Other tenants&apos; journals in DB</span>
              <span className="num text-ink">{ov.rls.foreignRowsInDatabase}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-dim">Visible to this session</span>
              <span className={`num ${ov.rls.visibleForeignRows === 0 ? "text-ok" : "text-bad"}`}>{ov.rls.visibleForeignRows}</span>
            </div>
            <p className="border-t border-line pt-3 text-xs leading-relaxed text-ink-faint">
              The query deliberately asks for <span className="num text-ink-dim">tenant_id &lt;&gt; current_tenant</span>. PostgreSQL
              row-level security filters it to zero rows inside the engine — even a buggy query cannot leak another
              tenant&apos;s data. Switch tenants in the top-right to see a completely different book.
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}
