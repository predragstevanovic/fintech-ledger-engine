import { getLatestReconciliation } from "@/core/reconciliation/reconciliation.service";
import { resolveActiveTenant } from "@/lib/tenant-context";
import { ReconciliationCenter } from "@/components/reconciliation-center";
import { PageHeader } from "@/components/ui";

export default async function ReconciliationPage() {
  const { active } = await resolveActiveTenant();
  if (!active) return null;
  const initial = await getLatestReconciliation(active.id);

  return (
    <>
      <PageHeader
        title="Reconciliation Center"
        subtitle="Set-based outer join of the internal ledger against an external PSP settlement report. Detects MATCHED, DISCREPANCY (amount differs), MISSING_IN_LEDGER (lost webhook) and MISSING_IN_PSP (settlement delay)."
      />
      <ReconciliationCenter key={active.id} tenantId={active.id} currency={active.settings.currency} initial={initial} />
    </>
  );
}
