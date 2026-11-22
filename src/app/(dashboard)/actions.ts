"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { TENANT_COOKIE, requireTenantId } from "@/lib/tenant-context";

/** Tenant Switcher: persists the active tenant; every page re-queries through RLS. */
export async function setActiveTenant(tenantId: string) {
  const tenant = await requireTenantId(tenantId);
  if (!tenant) return { ok: false as const };
  (await cookies()).set(TENANT_COOKIE, tenant.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  revalidatePath("/", "layout");
  return { ok: true as const };
}
