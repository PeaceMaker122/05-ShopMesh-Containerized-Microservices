const express = require("express");
const { findById } = require("./products");

const app = express();
const port = process.env.PORT || 3000;

// Health check used by the load balancer and ECS.
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Product lookup. The ALB routes /product* here; Cart calls this internally.
app.get("/product/:id", (req, res) => {
  const product = findById(req.params.id);
  if (!product) {
    return res.status(404).json({ error: "product not found" });
  }
  res.json(product);
});

app.listen(port, () => {
  console.log(`catalog service listening on port ${port}`);
});