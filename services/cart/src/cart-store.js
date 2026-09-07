// DynamoDB-backed cart store. Each cart is an item keyed by cartId, with its
// items stored as a list attribute. The table name comes from the environment.
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.CARTS_TABLE || "shopmesh-carts";

async function getOrCreate(cartId) {
  const res = await docClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { cartId: String(cartId) } }),
  );
  if (res.Item) {
    return res.Item;
  }
  const empty = { cartId: String(cartId), items: [], total: 0 };
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: empty }));
  return empty;
}

async function save(cart) {
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: cart }));
}

module.exports = { getOrCreate, save };