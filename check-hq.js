// Diagnoses why Corporate Office (HQ) attendance looks like it isn't syncing.
const { Client } = require("pg");
const url = process.env.DATABASE_URL;
if (!url) { console.error('Run it like: DATABASE_URL="..." node check-hq.js'); process.exit(1); }

(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();

  console.log("\n=== Corporate Office hotel record ===");
  const hotel = await c.query("SELECT id, name, device_id, biometric_status, last_sync FROM hotels WHERE id = 'HQ'");
  console.table(hotel.rows);

  console.log("\n=== Employees assigned to Corporate Office ===");
  const emps = await c.query("SELECT id, name, machine_user_id, status FROM employees WHERE hotel_id = 'HQ' ORDER BY id");
  console.table(emps.rows);

  console.log("\n=== Last 10 punches received from either Corporate Office serial ===");
  const punches = await c.query(
    `SELECT employee_code, log_datetime, device_sn, received_at FROM attendance_logs
     WHERE device_sn ILIKE '%455946%' OR device_sn ILIKE '%455948%'
     ORDER BY received_at DESC LIMIT 10`
  );
  console.table(punches.rows);
  console.log(`Total punches ever received from these two serials: ${(await c.query(
    `SELECT COUNT(*) FROM attendance_logs WHERE device_sn ILIKE '%455946%' OR device_sn ILIKE '%455948%'`
  )).rows[0].count}`);

  console.log("\n=== Any punches with a device_sn that DOESN'T match either known HQ serial exactly ===");
  const mismatched = await c.query(
    `SELECT DISTINCT device_sn, COUNT(*) FROM attendance_logs
     WHERE (device_sn ILIKE '%455946%' OR device_sn ILIKE '%455948%')
       AND device_sn NOT IN ('RSS20230455946', 'RSS20230455948')
     GROUP BY device_sn`
  );
  console.table(mismatched.rows);

  await c.end();
})().catch(e => { console.error("Failed:", e.message); process.exit(1); });
