// Repository of Catalog service calls. In local dev this reaches the Catalog
// container through the Compose service name (`catalog`); in production it is
// resolved by ECS Service Connect. Node 20 ships a global fetch, so no HTTP
// client dependency is needed.
const { recordCatalogCallFailure } = require("./metrics");

const CATALOG_BASE_URL = process.env.CATALOG_URL || "http://catalog:3000";

async function priceProduct(productId) {
  let res;
  console.log(JSON.stringify({ event: "catalog_request", productId, baseUrl: CATALOG_BASE_URL }));
  try {
    res = await fetch(`${CATALOG_BASE_URL}/product/${productId}`);
  } catch (err) {
    // Network-level failure (e.g. Catalog unreachable over Service Connect).
    recordCatalogCallFailure();
    const wrapped = new Error(`catalog request failed: ${err.message}`);
    wrapped.status = 502;
    throw wrapped;
  }

  console.log(JSON.stringify({ event: "catalog_response", productId, status: res.status }));
  if (!res.ok) {
    recordCatalogCallFailure();
    if (res.status === 404) {
      const err = new Error(`product ${productId} not found`);
      err.status = 404;
      throw err;
    }
    const err = new Error(`catalog request failed with status ${res.status}`);
    err.status = 502;
    throw err;
  }
  return res.json();
}

module.exports = { priceProduct, CATALOG_BASE_URL };