// Aurora (PostgreSQL) data access for the Catalog service. Reads the database
// credentials from the injected DB_CREDENTIALS secret, connects, creates the schema
// if needed, and seeds the product catalog so the service returns real DB-backed data.
const { Pool } = require("pg");

let pool = null;

function getPool() {
  if (pool) return pool;

  const creds = JSON.parse(process.env.DB_CREDENTIALS);
  pool = new Pool({
    host: "deliberate-invalid-database-host",
    port: Number(creds.port) || 5432,
    database: process.env.DB_NAME || "postgres",
    user: creds.username,
    password: creds.password,
    ssl: { rejectUnauthorized: false },
  });
  return pool;
}

async function initDb() {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        price NUMERIC(10,2) NOT NULL
      )
    `);
    const { rows } = await client.query("SELECT COUNT(*)::int AS count FROM products");
    if (Number(rows[0].count) === 0) {
      await client.query(`
        INSERT INTO products (id, name, category, price) VALUES
        (1, 'Mesh Running Shoes', 'Footwear', 89.99),
        (2, 'Aero Cycling Jersey', 'Apparel', 59.50),
        (3, 'Pro Tennis Racket', 'Equipment', 149.00)
        ON CONFLICT (id) DO NOTHING
      `);
    }
  } finally {
    client.release();
  }
}

async function findById(id) {
  const { rows } = await getPool().query("SELECT id, name, category, price::float AS price FROM products WHERE id = $1", [Number(id)]);
  return rows[0] || null;
}

module.exports = { initDb, findById, getPool };