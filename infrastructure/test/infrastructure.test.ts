import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { CatalogStack } from '../lib/catalog-stack';
import { CartStack } from '../lib/cart-stack';

const defaultEnv = {
  account: '123456789012',
  region: 'us-east-1',
};

test('Network stack creates a VPC and an internet-facing ALB', () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'TestNetworkStack', { env: defaultEnv });
  const template = Template.fromStack(stack);

  // A VPC with at least one private and one public subnet should exist.
  template.resourceCountIs('AWS::EC2::VPC', 1);
  template.hasResource('AWS::EC2::Subnet', {});

  // An internet-facing Application Load Balancer should exist.
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internet-facing',
  });
});

test('Catalog stack creates an ECR repo, Aurora cluster and secret', () => {
  const app = new cdk.App();
  const network = new NetworkStack(app, 'TestNetworkStack2', { env: defaultEnv });
  const stack = new CatalogStack(app, 'TestCatalogStack', {
    env: defaultEnv,
    vpc: network.vpc,
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::ECR::Repository', {
    RepositoryName: 'shopmesh-catalog',
    ImageScanningConfiguration: { ScanOnPush: true },
  });

  // Aurora Serverless v2 cluster (rds cluster + DB instances).
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    Engine: 'aurora-postgresql',
  });

  // CDK auto-creates a secret for the cluster credentials.
  const secrets = template.findResources('AWS::SecretsManager::Secret');
  expect(Object.keys(secrets).length).toBeGreaterThanOrEqual(1);
});

test('Cart stack creates an ECR repo and a DynamoDB table', () => {
  const app = new cdk.App();
  const stack = new CartStack(app, 'TestCartStack', { env: defaultEnv });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::ECR::Repository', {
    RepositoryName: 'shopmesh-cart',
    ImageScanningConfiguration: { ScanOnPush: true },
  });

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [{ AttributeName: 'cartId', KeyType: 'HASH' }],
    BillingMode: 'PAY_PER_REQUEST',
  });
});