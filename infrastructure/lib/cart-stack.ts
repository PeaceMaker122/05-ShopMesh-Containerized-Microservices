import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export interface CartStackProps extends cdk.StackProps {
  /** The shared ECS cluster from the NetworkStack. */
  readonly cluster: ecs.Cluster;
  /** The ECS Service Connect namespace from the NetworkStack. */
  readonly serviceConnectNamespace: servicediscovery.INamespace;
}

export class CartStack extends cdk.Stack {
  /** ECR repository for Cart container images. */
  public readonly repository: ecr.Repository;
  /** DynamoDB table backing the Cart service. */
  public readonly table: dynamodb.Table;
  /** The Fargate task definition for the Cart service. */
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  /** The Fargate service running Cart with Service Connect. */
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: CartStackProps) {
    super(scope, id, props);

    const { cluster, serviceConnectNamespace } = props;

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
      portMappings: [{ name: 'app', containerPort: 3001 }],
      environment: {
        PORT: '3001',
        CATALOG_URL: 'http://catalog:3000',
      },
    });

    // The ECS service. Cart joins the Service Connect mesh so its Service
    // Connect proxy can resolve the `catalog` service name when pricing items.
    this.service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: this.taskDefinition,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      serviceConnectConfiguration: {
        namespace: serviceConnectNamespace.namespaceName,
        services: [
          {
            portMappingName: 'app',
            dnsName: 'cart',
            port: 3001,
          },
        ],
      },
    });
  }
}