require('dotenv').config();
const { query } = require('./src/config/database');

async function test() {
  try {
    const API = 'http://localhost:4001/api/v1';
    const EMAIL = 'admin@spykar.com', PASS = 'Admin@123';

    // First login
    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    });
    const loginData = await loginRes.json();
    const token = loginData.accessToken || loginData.data?.accessToken;

    if (!token) {
      console.error("Login failed or no token returned:", loginData);
      process.exit(1);
    }

    // Call /analytics/sales
    const url = `${API}/analytics/sales?date_from=2026-05-01&date_to=2026-05-29&mode=active`;
    console.log("Fetching from:", url);
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const json = await res.json();
    console.log("Response summary:");
    console.log(JSON.stringify(json.data?.summary, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}
test();
