/**
 * Applies src/db/security.sql (RLS, immutability triggers, grants) over DIRECT_URL.
 * Usage: npm run db:security
 */
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

config({ path: ".env.local", quiet: true });

async function main() {
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL is not configured");
  const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  try {
    const script = readFileSync(join(process.cwd(), "src", "db", "security.sql"), "utf8");
    await sql.unsafe(script);
    const policies = await sql`
      select tablename, policyname from pg_policies where schemaname = 'public' order by 1, 2`;
    const triggers = await sql`
      select event_object_table as table, trigger_name from information_schema.triggers
      where trigger_schema = 'public' group by 1, 2 order by 1, 2`;
    console.log(`✔ security layer applied: ${policies.length} RLS policies, ${triggers.length} triggers`);
    for (const p of policies) console.log(`  policy  ${p.tablename}.${p.policyname}`);
    for (const t of triggers) console.log(`  trigger ${t.table}.${t.trigger_name}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("✘ apply-security failed:", err.message);
  process.exit(1);
});
