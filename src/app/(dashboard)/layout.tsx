import { Suspense } from "react";
import { CodeXml } from "lucide-react";
import { MobileNav, Sidebar, TenantSwitcher } from "@/components/shell";
import { resolveActiveTenant } from "@/lib/tenant-context";

/** Request-time tenant switcher (reads the cookie) — streamed inside a Suspense boundary. */
async function TenantControl() {
  const { tenants, active } = await resolveActiveTenant();
  if (!active) return null;
  return (
    <TenantSwitcher
      activeId={active.id}
      tenants={tenants.map((t) => ({ id: t.id, name: t.name, currency: t.settings.currency, industry: t.settings.industry }))}
    />
  );
}

function PageSkeleton() {
  return (
    <div className="animate-pulse space-y-6">
      <div className="h-8 w-72 rounded-lg bg-panel" />
      <div className="h-16 rounded-xl bg-panel" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-32 rounded-xl bg-panel" />
        ))}
      </div>
      <div className="h-72 rounded-xl bg-panel" />
    </div>
  );
}

export default function DashboardLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-line bg-canvas/80 px-6 py-3 backdrop-blur">
          <div className="flex items-center gap-2 text-xs text-ink-faint">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-ok" />
            Live · Supabase PostgreSQL · eu-west-2
          </div>
          <div className="flex items-center gap-3">
            <Suspense fallback={<div className="h-9 w-64 animate-pulse rounded-lg bg-panel" />}>
              <TenantControl />
            </Suspense>
            {process.env.NEXT_PUBLIC_REPO_URL ? (
              <a
                href={process.env.NEXT_PUBLIC_REPO_URL}
                className="hidden items-center gap-1.5 text-xs text-ink-faint hover:text-ink sm:flex"
                target="_blank"
                rel="noreferrer"
              >
                <CodeXml className="h-4 w-4" /> Source
              </a>
            ) : null}
          </div>
        </header>
        <MobileNav />
        <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
          <Suspense fallback={<PageSkeleton />}>{children}</Suspense>
        </main>
      </div>
    </div>
  );
}
