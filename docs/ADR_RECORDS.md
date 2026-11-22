# Architecture Decision Records (ADR)

Ovaj dokument beleži ključne arhitektonske odluke, razmatrane alternative i svesne kompromise (*trade-offs*) napravljene tokom dizajna sistema.

---

## ADR-001: Korišćenje BIGINT umesto DECIMAL/FLOAT za finansijske iznose

* **Status:** Prihvaćeno
* **Kontekst:** U JavaScript/TypeScript okruženju standardni `number` tip koristi IEEE 754 floating-point format, gde `0.1 + 0.2 === 0.30000000000000004`. Korišćenje `DECIMAL` tipa u bazi zahteva parsiranje stringova u aplikaciji i sporiju aritmetiku.
* **Odluka:** Svi novčani iznosi se u bazi čuvaju kao `BIGINT` (64-bitni ceo broj) u najmanjoj valutnoj jedinici (centi/pare), a u TypeScript-u se obrađuju isključivo putem nativnog `BigInt` tipa. Formatiranje u decimalni prikaz vrši se isključivo na prezentacionom (UI) sloju.
* **Kompromis (Trade-off):** Zahteva dodatnu pažnju prilikom JSON serijalizacije (jer `JSON.stringify` ne podržava `BigInt` nativno bez konverzije u string), ali garantuje 100% matematičku preciznost.

---

## ADR-002: Row-Level Security (RLS) umesto odvojenih baza ili šema po klijentu

* **Status:** Prihvaćeno
* **Kontekst:** Potrebno je obezbediti strogu izolaciju podataka za više B2B klijenata (Multi-Tenancy) na serverless infrastrukturi (Supabase + Vercel).
* **Razmatrane alternative:**
  1. *Database-per-tenant:* Preskupo i nemoguće za održavanje migracija na besplatnom tier-u.
  2. *Schema-per-tenant:* Otežava connection pooling u PgBouncer/Supavisor okruženju jer svaki tenant zahteva promenu `search_path`-a.
* **Odluka:** *Shared Table with PostgreSQL RLS*. Svi tenanti dele iste tabele sa obaveznom kolonom `tenant_id`, dok PostgreSQL RLS polise automatski filtriraju svaki `SELECT`, `INSERT`, `UPDATE` i `DELETE` na osnovu transakcijske sesije (`SET LOCAL app.current_tenant_id`).
* **Kompromis (Trade-off):** Zahteva da se svaki upit izvršava unutar transakcionog wrapper-a (`withTenant`), ali pruža izolaciju na nivou same baze bez gubitka performansi connection pooler-a.

---

## ADR-003: Dvostruki Idempotency sloj (Upstash Redis + PostgreSQL Unique Index)

* **Status:** Prihvaćeno
* **Kontekst:** Payment procesori garantuju *At-Least-Once* isporuku webhook-ova, što znači da isti događaj može stići više puta u razmaku od nekoliko milisekundi.
* **Odluka:** Implementiran je hibridni mehanizam. Prvi sloj je atomični `SET NX` u Upstash Redisu koji u memoriji odbija konkurentne duplikate pre nego što uopšte opterete bazu. Drugi sloj je kompozitni `UNIQUE(tenant_id, idempotency_key)` indeks u PostgreSQL-u koji služi kao trajni garant integriteta ukoliko Redis ključ istekne nakon 24 sata.
* **Kompromis (Trade-off):** Dodaje ~3-5ms latencije za mrežni poziv ka Upstash Redisu, ali drastično smanjuje opterećenje na primarnoj PostgreSQL bazi pod velikim opterećenjem.

---

## ADR-004: Asinhroni Webhook Ingestion preko QStash-a umesto direktnog upisa u bazu

* **Status:** Prihvaćeno
* **Kontekst:** Serverless funkcije na Vercelu se skaliraju horizontalno u stotinama instanci prilikom naglog skoka saobraćaja (npr. Black Friday). Direktan upis u bazu iz webhook rute može brzo iscrpeti limit aktivnih konekcija na PostgreSQL-u.
* **Odluka:** Webhook endpoint vrši isključivo kriptografsku proveru potpisa, prosleđuje događaj u Upstash QStash red čekanja i odmah vraća `202 Accepted`. Worker endpoint obrađuje poruke kontrolisanim tempom sa ugrađenim *Exponential Backoff* retry mehanizmom i *Dead-Letter Queue (DLQ)* podrškom.
* **Kompromis (Trade-off):** Uvodi blagi *Eventual Consistency* (kašnjenje od ~50-150ms između prijema webhook-a i vidljivosti u ledgeru), što je potpuno prihvatljivo za asinhronu obradu plaćanja i drastično povećava otpornost sistema.
---

## ADR-005: Namenska `ledger_app` rola bez BYPASSRLS (otkriveno tokom implementacije)

* **Status:** Prihvaćeno
* **Kontekst:** Supabase-ova `postgres` rola (kojom se aplikacija povezuje preko poolera) ima atribut `BYPASSRLS`. RLS polise iz blueprint-a bi zato bile **potpuno ignorisane** — izolacija bi postojala samo na papiru.
* **Odluka:** Kreirana je rola `ledger_app NOLOGIN NOBYPASSRLS` sa minimalnim privilegijama (bez `DELETE` nad ledger tabelama). `withTenant()` u istoj transakciji izvršava `set_config('app.current_tenant_id', …, true)` i `SET LOCAL ROLE ledger_app`. Polise su vezane `TO ledger_app`, imaju i `USING` i `WITH CHECK`, a tabele imaju `FORCE ROW LEVEL SECURITY`. Pristup `anon`/`authenticated` rolama (Supabase Data API) je opozvan.
* **Dokaz:** Integracioni test pokušava (a) čitanje tuđih redova, (b) knjiženje na tuđi račun i (c) upis reda sa tuđim `tenant_id` — sva tri su odbijena na nivou baze. Dashboard prikazuje "foreign rows in DB: N · visible: 0".
* **Kompromis:** Administrativni upiti (seed, audit) svesno rade kao `postgres` i zaobilaze RLS; nikada ne rade nad podacima na zahtev korisnika.

---

## ADR-006: Graceful fallback bez Upstash-a

* **Status:** Prihvaćeno
* **Kontekst:** Upstash kredencijali nisu obezbeđeni u prvom deploymentu, a sistem mora raditi na free tier-u bez ručne intervencije.
* **Odluka:** `lib/redis.ts` bira Upstash ako postoje `UPSTASH_REDIS_REST_*`, inače in-memory store sa istom `SET NX EX` semantikom (po instanci). Cache sloj je **fail-open** — DB `UNIQUE(tenant_id, idempotency_key)` je uvek autoritativan. `lib/qstash.ts` objavljuje u QStash ako postoji `QSTASH_TOKEN`, inače webhook ruta vraća `202` i obrađuje događaj posle odgovora preko Next.js `after()`.
* **Kompromis:** Bez QStash-a nema trajnog reda/DLQ-a; ako instanca padne posle `202`, događaj se gubi (PSP ga ponovo šalje, a Reconciliation ga detektuje kao `MISSING_IN_LEDGER`). Dodavanje 5 env varijabli aktivira pun režim bez izmene koda.

---

## ADR-007: `max_pipeline: 1` za Supavisor transaction pooler

* **Status:** Prihvaćeno
* **Kontekst:** Chaos simulator (35 paralelnih HTTP zahteva) je zaglavio server: `postgres-js` podrazumevano pipeline-uje do 100 upita po konekciji, a Supavisor u transaction modu pod konkurentnošću ostavlja backend-ove u stanju `active / ClientRead` — pool se trajno iscrpi.
* **Odluka:** `max_pipeline: 1` (jedan upit u letu po konekciji) + single-flight keš direktorijuma tenanata (30 s TTL, ograničen refresh na promašaj).
* **Kompromis:** Nešto manji throughput po konekciji, ali deterministično ponašanje pod opterećenjem; nakon izmene simulator prolazi 25/25 + 9/9 blokiranih duplikata.

---

## ADR-008: Model knjiženja uplate (bruto provizija + trošak procesora)

* **Status:** Prihvaćeno
* **Kontekst:** Split 82/15/3 mora dati izbalansiran nalog. Naivni model (Escrow 97% + Fees 3% na debit, Merchant 82% + Platform 15% na kredit) nije izbalansiran — seed skripta je ovu grešku uhvatila (`UNBALANCED`).
* **Odluka:** `DR Escrow 97% · DR PSP Fees 3% = CR Merchant Payable 82% · CR Platform Revenue 18%`. Platforma prihoduje bruto proviziju, a naknadu procesora knjiži kao rashod; neto prihod je tačno 15%. Refundacija je storno nalog sa identičnim stavkama u suprotnom smeru, sa idempotency ključem `refund:<payment_ref>` (najviše jedna refundacija po uplati, čak i pri trci različitih refund događaja).
