import Link from "next/link";
import { getJournals } from "@/core/dashboard/dashboard.queries";
import { resolveActiveTenant } from "@/lib/tenant-context";
import { LedgerTable } from "@/components/ledger-table";
import { PageHeader } from "@/components/ui";

const PAGE_SIZE = 25;

export default async function LedgerPage({ searchParams }: PageProps<"/ledger">) {
  const { active } = await resolveActiveTenant();
  if (!active) return null;
  const sp = await searchParams;
  const page = Math.max(1, Number(Array.isArray(sp.page) ? sp.page[0] : sp.page) || 1);
  const { rows, total } = await getJournals(active.id, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader
        title="Double-Entry Explorer"
        subtitle="Every journal entry and its immutable DEBIT / CREDIT lines. Click a row to expand it. Refunds are compensating (storno) entries; posted lines can never be updated or deleted."
        right={<span className="num text-xs text-ink-faint">{total.toLocaleString("en-US")} journals</span>}
      />
      <LedgerTable rows={rows} currency={active.settings.currency} />
      <div className="mt-4 flex items-center justify-between text-sm text-ink-dim">
        <span>
          Page {page} of {pages}
        </span>
        <div className="flex gap-2">
          {page > 1 ? (
            <Link className="rounded-lg border border-line px-3 py-1.5 hover:border-ink-faint" href={`/ledger?page=${page - 1}`}>
              Previous
            </Link>
          ) : null}
          {page < pages ? (
            <Link className="rounded-lg border border-line px-3 py-1.5 hover:border-ink-faint" href={`/ledger?page=${page + 1}`}>
              Next
            </Link>
          ) : null}
        </div>
      </div>
    </>
  );
}
