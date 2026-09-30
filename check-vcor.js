// Checks whether the VCOR-coded employees exist at all, and if so, what
// hotel they're actually assigned to.
const { Client } = require("pg");
const url = process.env.DATABASE_URL;
if (!url) { console.error('Run it like: DATABASE_URL="..." node check-vcor.js'); process.exit(1); }

(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();

  console.log("\n=== Every employee whose code starts with VCOR ===");
  const emps = await c.query("SELECT id, name, hotel_id, status FROM employees WHERE id ILIKE 'VCOR%' ORDER BY id");
  console.table(emps.rows);
  console.log(`Found ${emps.rows.length} matching employee(s).`);

  console.log("\n=== Distinct employee codes that have punched from the Corporate Office serial but match NO employee at all ===");
  const unmatched = await c.query(`
    SELECT al.employee_code, COUNT(*)::int AS punches, MAX(al.log_datetime) AS last_punch
    FROM attendance_logs al
    WHERE al.device_sn = 'RSS20230455946'
      AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = al.employee_code OR (e.machine_user_id <> '' AND e.machine_user_id = al.employee_code))
    GROUP BY al.employee_code ORDER BY punches DESC
  `);
  console.table(unmatched.rows);

  await c.end();
})().catch(e => { console.error("Failed:", e.message); process.exit(1); });
