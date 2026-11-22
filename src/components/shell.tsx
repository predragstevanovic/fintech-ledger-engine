"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { ArrowLeftRight, BookOpenCheck, Building2, ChevronDown, FlaskConical, LayoutDashboard, Loader2, ShieldCheck } from "lucide-react";
import { cn } from "./ui";
import { setActiveTenant } from "@/app/(dashboard)/actions";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/ledger", label: "Ledger Explorer", icon: BookOpenCheck },
  { href: "/reconciliation", label: "Reconciliation", icon: ArrowLeftRight },
  { href: "/simulator", label: "Chaos Simulator", icon: FlaskConical },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-panel/60 px-3 py-5 md:flex">
      <div className="mb-8 flex items-center gap-2.5 px-2">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-brand to-brand-2 text-sm font-bold text-white">L</div>
        <div>
          <div className="text-sm font-semibold tracking-tight">LedgerCore</div>
          <div className="text-[11px] text-ink-faint">Double-entry engine</div>
        </div>
      </div>
      <nav className="flex flex-col gap-0.5">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition",
                active ? "bg-panel-2 text-ink" : "text-ink-dim hover:bg-panel-2/60 hover:text-ink",
              )}
            >
              <Icon className={cn("h-4 w-4", active ? "text-brand" : "")} />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto rounded-lg border border-line bg-panel-2/60 p-3 text-[11px] leading-relaxed text-ink-faint">
        <div className="mb-1 flex items-center gap-1.5 text-ink-dim">
          <ShieldCheck className="h-3.5 w-3.5 text-ok" /> Postgres RLS enforced
        </div>
        Every query runs as <span className="num text-ink-dim">ledger_app</span> inside a tenant-scoped transaction.
      </div>
    </aside>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-line px-4 py-2 md:hidden">
      {NAV.map(({ href, label }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link key={href} href={href} className={cn("whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs", active ? "bg-panel-2 text-ink" : "text-ink-dim")}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function TenantSwitcher({
  tenants,
  activeId,
}: {
  tenants: { id: string; name: string; currency: string; industry?: string }[];
  activeId: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const active = tenants.find((t) => t.id === activeId);
  return (
    <label className="relative flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm hover:border-ink-faint">
      {pending ? <Loader2 className="h-4 w-4 animate-spin text-brand" /> : <Building2 className="h-4 w-4 text-ink-dim" />}
      <span className="sr-only">Active tenant</span>
      <select
        className="cursor-pointer appearance-none bg-transparent pr-6 text-ink outline-none"
        value={activeId}
        disabled={pending}
        onChange={(e) =>
          start(async () => {
            await setActiveTenant(e.target.value);
            router.refresh();
          })
        }
      >
        {tenants.map((t) => (
          <option key={t.id} value={t.id} className="bg-panel">
            {t.name} · {t.currency}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 h-4 w-4 text-ink-faint" />
      {active?.industry ? <span className="hidden text-xs text-ink-faint lg:inline">{active.industry}</span> : null}
    </label>
  );
}
