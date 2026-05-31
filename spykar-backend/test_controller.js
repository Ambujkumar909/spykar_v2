require('dotenv').config();
const { connectDatabase } = require('./src/config/database');
const analyticsController = require('./src/controllers/analytics.controller');

async function test() {
  try {
    await connectDatabase();

    const req = {
      query: {
        date_from: '2026-05-01',
        date_to: '2026-05-29',
        mode: 'active'
      }
    };

    const res = {
      json: function(data) {
        console.log("=== API RESPONSE SUMMARY ===");
        console.log(JSON.stringify(data.data?.summary, null, 2));
        
        console.log("\n=== FIRST 5 DAILY TREND ROWS ===");
        console.log(JSON.stringify(data.data?.daily?.slice(0, 5), null, 2));
        
        console.log("\n=== TOTAL DAILY TREND ROWS ===");
        console.log(data.data?.daily?.length);
      }
    };

    const next = function(err) {
      console.error("Next called with error:", err);
    };

    await analyticsController.getSalesAnalytics(req, res, next);

  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}
test();
