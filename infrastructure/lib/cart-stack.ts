import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface CartStackProps extends cdk.StackProps {
  /** The shared ECS cluster from the NetworkStack. */
  readonly cluster: ecs.Cluster;
}

export class CartStack extends cdk.Stack {
  /** ECR repository for Cart container images. */
  public readonly repository: ecr.Repository;
  /** DynamoDB table backing the Cart service. */
  public readonly table: dynamodb.Table;
  /** The Fargate task definition for the Cart service. */
  public readonly taskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: CartStackProps) {
    super(scope, id, props);

    const { cluster } = props;

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

    // Least-privilege task role: only accesses its own DynamoDB table.
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    this.table.grantReadWriteData(taskRole);

    // Execution role for ECS to pull the image and push logs.
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    this.repository.grantPull(executionRole);
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['*'],
      }),
    );

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole,
      executionRole,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
      },
    });

    this.taskDefinition.addContainer('App', {
      image: ecs.ContainerImage.fromEcrRepository(this.repository),
      portMappings: [{ containerPort: 3001 }],
      environment: {
        PORT: '3001',
        CATALOG_URL: 'http://catalog:3000',
      },
    });
  }
}