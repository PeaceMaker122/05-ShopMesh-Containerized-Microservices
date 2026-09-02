const express = require("express");
const { getOrCreate } = require("./cart-store");
const { priceProduct } = require("./catalog-client");

const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());

// Health check used by the load balancer and ECS.
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Get the current cart contents.
app.get("/cart/:id", (req, res) => {
  res.json(getOrCreate(req.params.id));
});

// Add an item to a cart. Cart calls Catalog internally to fetch the current
// price, then stores the item with that confirmed price. This is the
// service-to-service interaction that Service Connect enables in production.
app.post("/cart/:id/items", async (req, res) => {
  const { productId, quantity = 1 } = req.body || {};
  if (!productId) {
    return res.status(400).json({ error: "productId is required" });
  }

  try {
    const product = await priceProduct(productId);
    const cart = getOrCreate(req.params.id);

    cart.items.push({
      productId: Number(productId),
      name: product.name,
      price: product.price,
      quantity,
    });

    cart.total = cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    res.json(cart);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`cart service listening on port ${port}`);
});