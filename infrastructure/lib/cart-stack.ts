import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface CartStackProps extends cdk.StackProps {}

export class CartStack extends cdk.Stack {
  /** ECR repository for Cart container images. */
  public readonly repository: ecr.Repository;
  /** DynamoDB table backing the Cart service. */
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: CartStackProps = {}) {
    super(scope, id, props);

    // Cart's image registry. Image scanning on push checks for known
    // vulnerabilities the moment an image is uploaded, before it is deployed.
    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: 'shopmesh-cart',
      imageScanOnPush: true,
    });

    // Cart contents are key-value shaped: a user/cart ID with its items.
    // DynamoDB is the right fit: simple, high-throughput, no relational joins.
    this.table = new dynamodb.Table(this, 'CartsTable', {
      tableName: 'shopmesh-carts',
      partitionKey: { name: 'cartId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });
  }
}