// One-time fix for Corporate Office, built directly from Realtime's own
// employee export (TotalEmployee.csv):
//   1. Adds the 17 Corporate Office employees who were missing from HRMS,
//      and corrects VCOR020's hotel (was "Corporate", should be HQ).
//   2. Relinks the Sept 26 punches that were stored under a raw name
//      (from before the Employee Code binding was fixed on the Realtime
//      side) onto the correct employee code, so that attendance history
//      isn't lost.
// Safe to run more than once — every step uses upsert/match logic, not
// blind inserts.

const { Client } = require("pg");
const url = process.env.DATABASE_URL;
if (!url) { console.error('Run it like: DATABASE_URL="..." node fix-corporate-office.js'); process.exit(1); }

// [employee_code, name, card_no, designation, date_of_joining]
const EMPLOYEES = [
  ["VCOR001", "Souradeep Das", "00000001", "Digital Marketing Executive", "2026-01-01"],
  ["VCOR002", "Tanmay Bhowmick", "00000002", "Graphic Designer", "2026-01-01"],
  ["VCOR003", "Raj Majhi", "00000003", "Guest Relations Executive", "2026-01-01"],
  ["VCOR004", "Bindhya Subba", "00000004", "Assistant Manager Reservations", "2026-01-01"],
  ["VCOR005", "Arpita Bairagi", "00000005", "Human Resources Associate", "2026-01-01"],
  ["VCOR006", "Yogya Chettri", "00000006", "Sr. Sales Executive", "2026-01-01"],
  ["VCOR007", "Ambrish Khetan", "00000007", "Corporate Head Finance", "2026-01-01"],
  ["VCOR008", "Regina Gurung", "00000008", "Reservation Executive", "2026-01-01"],
  ["VCOR009", "Samratt Laha", "00000009", "Head Quality & B D", "2026-01-01"],
  ["VCOR010", "Bikram Godiyala", "00000010", "Assstant Manager Sales", "2026-01-01"],
  ["VCOR013", "Susmita Roy", "00000012", "Sales Executive", "2026-01-01"],
  ["VCOR014", "Sangeeta Biswas", "00000013", "Office Girl", "2026-01-01"],
  ["VCOR015", "Amy Shreshtha", "00000014", "Guest Relations Executive", "2026-01-01"],
  ["VCOR017", "Pratik Chhetri", "00000015", "Intern", "2026-01-01"],
  ["VCOR018", "Manisha Jha", "00000016", "Accounts Assitant", "2026-01-01"],
  ["VCOR020", "Prayankar Dahal", "00000017", "Assistant Manager-Human Resources", "2026-01-01"],
  ["VCOR021", "Bijoy Sarkar", "00000018", "DEMO", "2026-01-01"],
  ["VCOR022", "Arun Karki", "00000019", "Assstant Manager Sales", "2026-01-01"],
  ["VCOR023", "Ranjan Kumar", "00000021", "Purchase And Store Manager", "2026-01-01"],
  ["VCOR024", "Prayash Gurung", "00000022", "DEMO", "2026-09-21"],
];

// [raw name as currently stored in attendance_logs, correct employee_code]
const RELINK = [
  ["Souradeep Das", "VCOR001"],
  ["Tanmay Bhowmick", "VCOR002"],
  ["Raj Majhi", "VCOR003"],
  ["Bindhya Subba", "VCOR004"],
  ["Arpita Bairagi", "VCOR005"],
  ["Yogya Chettri", "VCOR006"],
  ["Ambrish Khetan", "VCOR007"],
  ["Regina Gurung", "VCOR008"],
  ["Bikram Godiyala", "VCOR010"],
  ["Susmita Roy", "VCOR013"],
  ["Sangeeta Biswas", "VCOR014"],
  ["Amy Shreshtha", "VCOR015"],
  ["Pratik Chhetri", "VCOR017"],
  ["Manisha Jha", "VCOR018"],
  ["Prayankar Dahal", "VCOR020"],
];

const HQ_SERIALS = ["RSS20230455946", "RSS20230455948"];

async function main() {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();

  console.log("=== Step 1: adding/updating Corporate Office employees ===");
  let created = 0, updated = 0;
  for (const [id, name, card, role, doj] of EMPLOYEES) {
    const existing = await c.query("SELECT id FROM employees WHERE id = $1", [id]);
    if (existing.rows.length) {
      await c.query(
        `UPDATE employees SET name = $2, hotel_id = 'HQ', machine_user_id = $3, role = $4,
           date_of_joining = COALESCE(date_of_joining, $5::date)
         WHERE id = $1`,
        [id, name, card, role, doj]
      );
      updated++;
      console.log(`  updated ${id} (${name})`);
    } else {
      await c.query(
        `INSERT INTO employees (id, name, hotel_id, role, status, machine_user_id, monthly_salary, date_of_joining, property_code)
         VALUES ($1,$2,'HQ',$3,'Active',$4,0,$5,$1)`,
        [id, name, role, card, doj]
      );
      created++;
      console.log(`  created ${id} (${name})`);
    }
  }
  console.log(`Done: ${created} created, ${updated} updated.`);

  console.log("\n=== Step 2: relinking Sept 26 punches from raw name to employee code ===");
  for (const [rawName, code] of RELINK) {
    const r = await c.query(
      `UPDATE attendance_logs SET employee_code = $1
       WHERE employee_code = $2 AND device_sn = ANY($3::text[])`,
      [code, rawName, HQ_SERIALS]
    );
    console.log(`  "${rawName}" -> ${code}: ${r.rowCount} punch(es) relinked`);
  }

  console.log("\n=== Step 3: confirming Corporate Office now has punches matched ===");
  const check = await c.query(`
    SELECT COUNT(*)::int AS unmatched FROM attendance_logs al
    WHERE al.device_sn = ANY($1::text[])
      AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = al.employee_code OR (e.machine_user_id <> '' AND e.machine_user_id = al.employee_code))
  `, [HQ_SERIALS]);
  console.log(`Remaining unmatched punches from Corporate Office devices: ${check.rows[0].unmatched}`);
  console.log("(This should now only include the card '00000020' punches and anyone not in Realtime's export yet.)");

  await c.end();
}

main().catch(e => { console.error("Failed:", e.message); process.exit(1); });
