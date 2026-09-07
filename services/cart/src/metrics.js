// Emits a CloudWatch custom metric for failed Cart to Catalog calls. This is
// the signal that plain infrastructure metrics won't surface on their own, and it
// drives the Cart to Catalog failure-rate alarm used by the triage pipeline.
const { CloudWatchClient, PutMetricDataCommand } = require("@aws-sdk/client-cloudwatch");

const client = new CloudWatchClient({ region: process.env.AWS_REGION || "us-east-1" });

const NAMESPACE = "ShopMesh";
const METRIC_NAME = "CatalogCallFailure";

// Counts failures in a short window so the metric is publishable as a value.
let failureCount = 0;
let flushTimer = null;

function recordCatalogCallFailure() {
  failureCount += 1;
  if (!flushTimer) {
    flushTimer = setTimeout(flush, 10000);
  }
}

function flush() {
  flushTimer = null;
  if (failureCount === 0) return;

  const value = failureCount;
  failureCount = 0;

  client.send(
    new PutMetricDataCommand({
      Namespace: NAMESPACE,
      MetricData: [
        {
          MetricName: METRIC_NAME,
          Value: value,
          Unit: "Count",
          Timestamp: new Date(),
        },
      ],
    }),
  ).catch((err) => {
    console.error("failed to publish catalog call failure metric", err);
  });
}

module.exports = { recordCatalogCallFailure };