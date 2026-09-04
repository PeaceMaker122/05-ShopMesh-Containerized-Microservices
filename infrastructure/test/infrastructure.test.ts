import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { CatalogStack } from '../lib/catalog-stack';
import { CartStack } from '../lib/cart-stack';
import { OpsStack } from '../lib/ops-stack';

const defaultEnv = {
  account: '123456789012',
  region: 'us-east-1',
};

test('Network stack creates a VPC, an ALB, an ECS cluster and HTTPS', () => {
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

  // A shared ECS cluster should exist.
  template.hasResourceProperties('AWS::ECS::Cluster', {});

  // A Cloud Map namespace for ECS Service Connect should exist.
  template.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', {});

  // An ACM certificate is created for HTTPS.
  template.hasResourceProperties('AWS::CertificateManager::Certificate', {
    DomainName: 'stiaan.click',
  });

  // An HTTPS listener on 443 exists.
  const listeners = template.findResources('AWS::ElasticLoadBalancingV2::Listener');
  const https = Object.values(listeners).some(
    (l: any) => l.Properties.Port === 443 && l.Properties.Certificates,
  );
  expect(https).toBe(true);
});

test('Catalog stack creates an ECR repo, Aurora cluster, secret, task definition and Service Connect service', () => {
  const app = new cdk.App();
  const network = new NetworkStack(app, 'TestNetworkStack2', { env: defaultEnv });
  const stack = new CatalogStack(app, 'TestCatalogStack', {
    env: defaultEnv,
    vpc: network.vpc,
    cluster: network.cluster,
    serviceConnectNamespace: network.serviceConnectNamespace,
    httpsListener: network.httpsListener,
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

  // A Fargate task definition runs the Catalog container on port 3000.
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    RequiresCompatibilities: ['FARGATE'],
  });

  // An ECS service enables Service Connect so Catalog is reachable as `catalog`.
  template.hasResourceProperties('AWS::ECS::Service', {
    ServiceConnectConfiguration: {
      Enabled: true,
      Services: [
        {
          PortName: 'app',
          ClientAliases: [{ DnsName: 'catalog', Port: 3000 }],
        },
      ],
    },
  });

  // A target group routes /product* to Catalog.
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    Port: 3000,
  });

  // A listener rule matches the /product* path.
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
    Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/product*'] } }],
  });

  // Catalog auto scales up to 4 tasks on CPU.
  template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
    MaxCapacity: 4,
    MinCapacity: 1,
  });
});

test('Cart stack creates an ECR repo, DynamoDB table, task definition and Service Connect service', () => {
  const app = new cdk.App();
  const network = new NetworkStack(app, 'TestNetworkStack3', { env: defaultEnv });
  const stack = new CartStack(app, 'TestCartStack', {
    env: defaultEnv,
    cluster: network.cluster,
    vpc: network.vpc,
    serviceConnectNamespace: network.serviceConnectNamespace,
    httpsListener: network.httpsListener,
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::ECR::Repository', {
    RepositoryName: 'shopmesh-cart',
    ImageScanningConfiguration: { ScanOnPush: true },
  });

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [{ AttributeName: 'cartId', KeyType: 'HASH' }],
    BillingMode: 'PAY_PER_REQUEST',
  });

  // A Fargate task definition runs the Cart container on port 3001.
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    RequiresCompatibilities: ['FARGATE'],
  });

  // An ECS service enables Service Connect so Cart is in the mesh.
  template.hasResourceProperties('AWS::ECS::Service', {
    ServiceConnectConfiguration: {
      Enabled: true,
      Services: [
        {
          PortName: 'app',
          ClientAliases: [{ DnsName: 'cart', Port: 3001 }],
        },
      ],
    },
  });

  // A target group routes /cart* to Cart.
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    Port: 3001,
  });

  // A listener rule matches the /cart* path.
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
    Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/cart*'] } }],
  });

  // Cart auto scales up to 3 tasks on CPU, independently from Catalog.
  template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
    MaxCapacity: 3,
    MinCapacity: 1,
  });
});

test('Ops stack creates a GitHub Actions OIDC role scoped to ECR and ECS', () => {
  const app = new cdk.App();
  const network = new NetworkStack(app, 'TestNetworkStack4', { env: defaultEnv });
  const catalog = new CatalogStack(app, 'TestCatalogOps', {
    env: defaultEnv,
    vpc: network.vpc,
    cluster: network.cluster,
    serviceConnectNamespace: network.serviceConnectNamespace,
    httpsListener: network.httpsListener,
  });
  const cart = new CartStack(app, 'TestCartOps', {
    env: defaultEnv,
    cluster: network.cluster,
    vpc: network.vpc,
    serviceConnectNamespace: network.serviceConnectNamespace,
    httpsListener: network.httpsListener,
  });
  const stack = new OpsStack(app, 'TestOpsStack', {
    env: defaultEnv,
    catalogRepository: catalog.repository,
    catalogService: catalog.service,
    cartRepository: cart.repository,
    cartService: cart.service,
  });
  const template = Template.fromStack(stack);

  // A GitHub OIDC provider exists (deployed via a CDK custom resource).
  template.hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
    Url: 'https://token.actions.githubusercontent.com',
  });

  // A role exists that trusts GitHub via OIDC WebIdentity.
  const roles = template.findResources('AWS::IAM::Role');
  const rolesJson = JSON.stringify(roles);
  expect(rolesJson).toContain('sts:AssumeRoleWithWebIdentity');
  expect(rolesJson).toContain('repo:PeaceMaker122@214525680/05-ShopMesh-Containerized-Microservices@1352806286');

  // The role can push to both ECR repos (catalog + cart) and update both
  // ECS services. The repo ARNs come from other stacks via ImportValue.
  const policies = template.findResources('AWS::IAM::Policy');
  const policyJson = JSON.stringify(policies);
  const ecrPushActions = ['ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:PutImage'];
  expect(policyJson).toContain('ecr:PutImage');
  // Two ECR grants (catalog + cart) via cross-stack imports.
  expect(policyJson).toContain('TestCatalogOps:ExportsOutputFnGetAttRepository');
  expect(policyJson).toContain('TestCartOps:ExportsOutputFnGetAttRepository');
  // Can update both ECS services.
  expect(policyJson).toContain('ecs:UpdateService');
  expect(ecrPushActions.every((a) => policyJson.includes(a))).toBe(true);
});