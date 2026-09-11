const express = require("express");
const { initDb, findById, getPool } = require("./db");

const app = express();
const port = process.env.PORT || 3000;

// Health check used by the load balancer and ECS. It also reports whether the
// database is reachable, so the ALB only routes to healthy, DB-backed tasks.

app.get("/health", async (req, res) => {
  try {
    await getPool().query("SELECT 1");
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    res.status(503).json({ status: "degraded", db: "unreachable" });
  }
});

// Product lookup. The ALB routes /product* here; Cart calls this internally.

app.get("/product/:id", async (req, res) => {
  const productId = Number(req.params.id);
  console.log(JSON.stringify({ event: "catalog_product_lookup", productId }));
  return res.status(500).json({ error: "deliberate alarm test" });
  try {
    const product = await findById(productId);
    if (!product) {
      return res.status(404).json({ error: "product not found" });
    }
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: "database error" });
  }
});

async function start() {
  try {
    await initDb();
    console.log("catalog database initialized");
  } catch (err) {
    console.error("failed to initialize catalog database", err);
  }
  app.listen(port, () => {
    console.log(`catalog service listening on port ${port}`);
  });
}

start();