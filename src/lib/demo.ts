import type { TenantSettings } from "@/db/schema";

/**
 * Public demo tenants. Their API keys are intentionally published (README) so that
 * reviewers can call the API with curl; only SHA-256 hashes are stored in the DB.
 * Never use this pattern for real customer keys.
 */
export const DEMO_TENANTS = [
  {
    id: "0b4a6f5e-1d2c-4e8b-9a71-5c3d2e1f0a01",
    name: "BalkanDelivery d.o.o.",
    apiKey: "sk_demo_balkandelivery_4f8a2c91",
    settings: {
      currency: "RSD",
      industry: "Food delivery marketplace",
      split: { merchantBp: 8200, platformBp: 1500, pspFeeBp: 300 },
    } satisfies TenantSettings,
  },
  {
    id: "7e2d9c4b-3a5f-4c1e-8d6b-2f9a1b0c0b02",
    name: "AdriaticRide Mobility",
    apiKey: "sk_demo_adriaticride_9c217e3d",
    settings: {
      currency: "EUR",
      industry: "Ride-hailing platform",
      split: { merchantBp: 7500, platformBp: 2200, pspFeeBp: 300 },
    } satisfies TenantSettings,
  },
] as const;

export function demoApiKeyFor(tenantId: string): string | undefined {
  return DEMO_TENANTS.find((t) => t.id === tenantId)?.apiKey;
}
