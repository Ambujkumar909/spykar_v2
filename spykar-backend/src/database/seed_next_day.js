require('dotenv').config();

const sql = require('mssql');

const sqlServerConfig = {
  server: process.env.MSSQL_HOST,
  port: parseInt(process.env.MSSQL_PORT, 10) || 1433,
  database: process.env.MSSQL_DATABASE,
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  options: {
    encrypt: process.env.MSSQL_ENCRYPT === 'true',
    trustServerCertificate: true,
    requestTimeout: 60000,
    connectionTimeout: 15000,
  },
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
};

function pad(num) {
  return String(num).padStart(2, '0');
}

function formatSqlDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFrom(list) {
  return list[randomInt(0, list.length - 1)];
}

async function seedNextDay() {
  let pool;

  try {
    pool = await sql.connect(sqlServerConfig);

    const latestDateResult = await pool.request().query(`
      SELECT MAX(latest_date) AS latest_date
      FROM (
        SELECT MAX(sale_date) AS latest_date FROM SalesOrders
        UNION ALL
        SELECT MAX(dispatch_date) AS latest_date FROM Dispatch
        UNION ALL
        SELECT MAX(receipt_date) AS latest_date FROM GoodsReceipt
      ) activity
    `);

    const latestDate = latestDateResult.recordset[0]?.latest_date || new Date();
    const nextDate = addDays(new Date(latestDate), 1);
    const nextDateSql = formatSqlDate(nextDate);

    const [storeResult, warehouseResult, skuResult] = await Promise.all([
      pool.request().query(`SELECT TOP 20 loc_code FROM LocationMaster WHERE is_active = 1 AND UPPER(loc_type) IN ('COCO', 'FOFO', 'STORE') ORDER BY NEWID()`),
      pool.request().query(`SELECT TOP 10 loc_code FROM LocationMaster WHERE is_active = 1 AND UPPER(loc_type) IN ('WAREHOUSE', 'WH') ORDER BY NEWID()`),
      pool.request().query(`SELECT TOP 50 item_code, item_name, mrp FROM ItemMaster WHERE is_active = 1 ORDER BY NEWID()`),
    ]);

    const stores = storeResult.recordset.map((row) => row.loc_code);
    const warehouses = warehouseResult.recordset.map((row) => row.loc_code);
    const skuPool = skuResult.recordset;

    if (!stores.length || !warehouses.length || !skuPool.length) {
      throw new Error('Required seed source data is missing in SQL Server tables.');
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    const request = new sql.Request(transaction);

    let salesInserted = 0;
    let dispatchesInserted = 0;
    let receiptsInserted = 0;

    for (let saleIndex = 0; saleIndex < 12; saleIndex += 1) {
      const saleNo = `SO-${nextDateSql.replace(/-/g, '')}-${pad(saleIndex + 1)}`;
      const storeCode = randomFrom(stores);
      const lineCount = randomInt(2, 4);

      await request.query(`
        INSERT INTO SalesOrders (sale_no, store_code, sale_date)
        VALUES ('${saleNo}', '${storeCode}', '${nextDateSql}')
      `);

      for (let detailIndex = 0; detailIndex < lineCount; detailIndex += 1) {
        const sku = randomFrom(skuPool);
        const qty = randomInt(1, 6);

        await request.query(`
          INSERT INTO SalesOrderDetails (sale_no, item_code, qty_sold)
          VALUES ('${saleNo}', '${sku.item_code}', ${qty})
        `);
      }

      salesInserted += 1;
    }

    for (let dispatchIndex = 0; dispatchIndex < 6; dispatchIndex += 1) {
      const dispatchNo = `DSP-${nextDateSql.replace(/-/g, '')}-${pad(dispatchIndex + 1)}`;
      const fromWarehouse = randomFrom(warehouses);
      const toStore = randomFrom(stores);
      const lineCount = randomInt(2, 5);

      await request.query(`
        INSERT INTO Dispatch (
          dispatch_no, from_loc_code, to_loc_code, status,
          dispatch_date, expected_date, delivered_date, courier, tracking_no
        )
        VALUES (
          '${dispatchNo}',
          '${fromWarehouse}',
          '${toStore}',
          'DISPATCHED',
          '${nextDateSql}',
          '${formatSqlDate(addDays(nextDate, 2))}',
          NULL,
          'BlueDart',
          'TRK-${nextDateSql.replace(/-/g, '')}${pad(dispatchIndex + 1)}'
        )
      `);

      for (let detailIndex = 0; detailIndex < lineCount; detailIndex += 1) {
        const sku = randomFrom(skuPool);
        const qty = randomInt(8, 30);

        await request.query(`
          INSERT INTO DispatchDetails (dispatch_no, item_code, qty_ordered, qty_dispatched, qty_received)
          VALUES ('${dispatchNo}', '${sku.item_code}', ${qty}, ${qty}, 0)
        `);
      }

      dispatchesInserted += 1;
    }

    for (let receiptIndex = 0; receiptIndex < 8; receiptIndex += 1) {
      const receiptNo = `GRN-${nextDateSql.replace(/-/g, '')}-${pad(receiptIndex + 1)}`;
      const warehouse = randomFrom(warehouses);
      const lineCount = randomInt(2, 4);

      await request.query(`
        INSERT INTO GoodsReceipt (receipt_no, loc_code, receipt_date)
        VALUES ('${receiptNo}', '${warehouse}', '${nextDateSql}')
      `);

      for (let detailIndex = 0; detailIndex < lineCount; detailIndex += 1) {
        const sku = randomFrom(skuPool);
        const qty = randomInt(15, 40);

        await request.query(`
          INSERT INTO GoodsReceiptDetails (receipt_no, item_code, qty_received)
          VALUES ('${receiptNo}', '${sku.item_code}', ${qty})
        `);
      }

      receiptsInserted += 1;
    }

    await transaction.commit();

    console.log(`Added ${salesInserted} sales, ${dispatchesInserted} dispatches, ${receiptsInserted} receipts for ${nextDateSql}`);
    console.log('Next step: click the Sync button on the Spykar IQ dashboard to pull this new day into PostgreSQL.');
  } catch (error) {
    console.error(`Failed to seed next day transactions: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (pool) {
      await pool.close();
    }
  }
}

seedNextDay();
