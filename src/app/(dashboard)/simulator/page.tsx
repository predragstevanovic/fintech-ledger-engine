import { resolveActiveTenant } from "@/lib/tenant-context";
import { SimulatorConsole } from "@/components/simulator-console";
import { PageHeader } from "@/components/ui";

export default async function SimulatorPage() {
  const { active } = await resolveActiveTenant();
  if (!active) return null;
  return (
    <>
      <PageHeader
        title="Chaos & Concurrency Simulator"
        subtitle="Stress the engine with real concurrent HTTP traffic against the production API: pessimistic row locks in ascending order (no deadlocks), two-layer idempotency (cache + UNIQUE index) and async webhook ingestion."
      />
      <SimulatorConsole key={active.id} tenantId={active.id} currency={active.settings.currency} />
    </>
  );
}
