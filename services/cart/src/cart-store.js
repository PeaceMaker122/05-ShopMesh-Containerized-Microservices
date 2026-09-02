// In-memory cart store for local development.
// Replaced by DynamoDB once the data layer is built.
const carts = {};

function getOrCreate(cartId) {
  if (!carts[cartId]) {
    carts[cartId] = { id: cartId, items: [], total: 0 };
  }
  return carts[cartId];
}

module.exports = { getOrCreate };