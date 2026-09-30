// Diagnoses a specific employee's login: whether they exist, what state
// their account is in, and what the current shared first-login password is.
const { Client } = require("pg");
const url = process.env.DATABASE_URL;
const empId = process.argv[2];
if (!url) { console.error('Run it like: DATABASE_URL="..." node check-login.js VCOR017'); process.exit(1); }
if (!empId) { console.error('Pass the employee ID as an argument, e.g.: node check-login.js VCOR017'); process.exit(1); }

(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();

  console.log(`\n=== Employee record for "${empId}" ===`);
  const emp = await c.query(
    "SELECT id, name, hotel_id, status, must_reset_password, (password_hash <> '') AS has_own_password FROM employees WHERE id = $1",
    [empId]
  );
  console.table(emp.rows);
  if (!emp.rows.length) {
    console.log(`No employee with id "${empId}" exists. That alone explains a login failure — check for typos or extra spaces.`);
  }

  console.log("\n=== Current shared first-login password (used only while must_reset_password is true) ===");
  const setting = await c.query("SELECT value FROM settings WHERE key = 'default_employee_password'");
  console.log(setting.rows.length ? `Set explicitly to: "${setting.rows[0].value}"` : 'Not set — falling back to the built-in default: "Welcome@123"');

  await c.end();
})().catch(e => { console.error("Failed:", e.message); process.exit(1); });
