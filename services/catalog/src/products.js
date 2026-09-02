// In-memory product catalog for local development.
// Replaced by Aurora Serverless v2 (PostgreSQL) once the data layer is built.
const products = [
  { id: 1, name: "Mesh Running Shoes", category: "Footwear", price: 89.99 },
  { id: 2, name: "Aero Cycling Jersey", category: "Apparel", price: 59.5 },
  { id: 3, name: "Pro Tennis Racket", category: "Equipment", price: 149.0 },
];

function findById(id) {
  return products.find((p) => p.id === Number(id));
}

module.exports = { products, findById };