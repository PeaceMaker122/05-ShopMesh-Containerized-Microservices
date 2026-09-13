# ShopMesh Infrastructure

This directory contains the AWS CDK application that defines the ShopMesh platform. The root README tells the project story. This README explains how the infrastructure is organized, tested, deployed, and removed.

The CDK application targets `us-east-1` and defines four application stacks:

- `NetworkStack`
- `CatalogStack`
- `CartStack`
- `OpsStack`

The application uses AWS CDK with TypeScript. CDK synthesizes the TypeScript constructs into CloudFormation templates, and CloudFormation manages the AWS resources.

## Infrastructure responsibilities

### NetworkStack

`NetworkStack` provides the shared network foundation:

- VPC across multiple Availability Zones
- Public subnets for the internet-facing Application Load Balancer
- Private subnets with egress for ECS tasks and databases
- NAT gateway for private task egress
- HTTP listener and HTTPS listener
- ACM certificate integration for `stiaan.click`
- Shared ECS cluster
- ECS Service Connect private namespace

### CatalogStack

`CatalogStack` owns the Catalog service and its data:

- Catalog ECR repository
- Catalog Fargate task definition and service
- Catalog task and execution IAM roles
- Aurora Serverless v2 PostgreSQL cluster
- Secrets Manager database credentials
- Catalog security group
- Catalog target group and `/product*` ALB rule
- Catalog CPU target-tracking scaling policy

Catalog listens on port 3000. Its `/health` endpoint checks database connectivity, so the ALB only routes requests to Catalog tasks that can reach Aurora.

### CartStack

`CartStack` owns the Cart service and its data:

- Cart ECR repository
- Cart Fargate task definition and service
- Cart task and execution IAM roles
- DynamoDB table named `shopmesh-carts`
- Cart security group
- Cart target group and `/cart*` ALB rule
- Cart CPU target-tracking scaling policy

Cart listens on port 3001. Its task uses `CATALOG_URL=http://catalog:3000` to call Catalog through Service Connect.

### OpsStack

`OpsStack` provides delivery and operations:

- GitHub OIDC provider and staging/production deployment roles
- CloudWatch log groups and container logging
- ECS Container Insights
- CloudWatch alarms
- EventBridge alarm rules
- Triage Lambda
- Bedrock invocation permissions
- SNS triage topic and email subscription

The deployment roles use short-lived GitHub OIDC credentials rather than stored AWS access keys. Runtime roles and deployment roles are separate and scoped to their responsibilities.

## Stack dependency order

The resources have a deliberate dependency order:

```text
NetworkStack
    ↓
CatalogStack and CartStack
    ↓
OpsStack
```

CDK and CloudFormation derive the dependency relationships from the resources passed between stacks. Deploying with `--all` allows CDK to deploy the stacks in the correct order.

Catalog and Cart are separate service stacks so they can be changed, deployed, and scaled independently. Operations is kept in one stack because logging, alarms, triage, SNS, and CI/CD permissions form one supporting platform layer.

## Infrastructure source layout

```text
infrastructure/
├── bin/
│   └── infrastructure.ts       # CDK app entry point and stack wiring
├── lib/
│   ├── network-stack.ts        # VPC, ALB, ECS cluster, Service Connect
│   ├── catalog-stack.ts        # Catalog, Aurora, ECR, IAM, routing
│   ├── cart-stack.ts           # Cart, DynamoDB, ECR, IAM, routing
│   └── ops-stack.ts            # CI/CD, logging, alarms, triage, SNS
├── test/
│   └── infrastructure.test.ts  # CDK assertions and permission tests
├── cdk.json                    # CDK app command and context
├── package.json                # Build, test, and CDK commands
└── tsconfig.json               # TypeScript compiler configuration
```

## Prerequisites

Install or configure:

- Node.js and npm
- AWS CLI credentials with permission to use CDK and deploy the required resources
- AWS CDK CLI through the local project dependency
- A bootstrapped CDK environment in `us-east-1`
- The Route 53 hosted zone and ACM prerequisites for `stiaan.click`
- GitHub repository secrets and permissions for the OIDC deployment workflows

Check the active AWS identity before deploying:

```bash
aws sts get-caller-identity
aws configure get region
```

The application is designed for `us-east-1`. Set the AWS CLI region explicitly when there is any doubt:

```bash
aws configure set region us-east-1
```

Do not store database passwords or long-lived AWS keys in this repository. Aurora credentials are generated and managed through Secrets Manager by CDK.

## Local service development

The application containers are defined in the repository-root `compose.yaml`. Run these commands from the repository root, not from this directory:

```bash
docker compose build
docker compose up -d
```

Test the local Catalog service:

```bash
curl http://localhost:3000/product/1
```

Test the local Cart-to-Catalog flow:

```bash
curl -X POST http://localhost:3001/cart/1/items \
  -H "Content-Type: application/json" \
  --data '{"productId":1,"quantity":1}'
```

Stop the local containers when finished:

```bash
docker compose down
```

On PowerShell, use single quotes around the JSON body. Backslashes do not escape double quotes in PowerShell:

```powershell
curl.exe -i -X POST http://localhost:3001/cart/1/items -H 'Content-Type: application/json' --data '{"productId":1,"quantity":1}'
```

## Build and test the CDK application

From this directory:

```bash
npm install
npm run build
npm test
```

List the CDK stacks:

```bash
npx cdk ls
```

Synthesize CloudFormation templates without changing AWS resources:

```bash
npx cdk synth --all
```

Compare the local CDK templates with the deployed environment:

```bash
npx cdk diff --all
```

The tests use CDK assertions to check the core infrastructure, stack relationships, IAM permissions, and deployment configuration. Run the tests before deploying infrastructure changes.

## Deploy the infrastructure

Deploy all application stacks:

```bash
npx cdk deploy --all --require-approval never
```

For a first deployment or a targeted change, deploy the stacks individually in dependency order:

```bash
npx cdk deploy NetworkStack --require-approval never
npx cdk deploy CatalogStack --require-approval never
npx cdk deploy CartStack --require-approval never
npx cdk deploy OpsStack --require-approval never
```

Review the CDK diff before deploying changes that affect databases, networking, security groups, IAM, or task definitions:

```bash
npx cdk diff --all
```

After deployment, verify:

1. All four stacks are complete in CloudFormation.
2. The ECS cluster has healthy Catalog and Cart tasks.
3. ALB target groups show healthy targets.
4. Catalog can return a product through `https://stiaan.click/product/1`.
5. Cart can add a product through `/cart/{id}/items`.
6. CloudWatch log groups receive application logs.
7. CloudWatch alarms and the triage resources exist.

## Deployment safety

Both Fargate services use the ECS deployment circuit breaker with rollback enabled:

```typescript
circuitBreaker: {
  rollback: true,
}
```

The ALB health check is part of the deployment safety path. A new task that cannot pass `/health` is removed from service, and ECS can roll back to the previous task definition.

The GitHub Actions deployment workflow creates a new task-definition revision by:

1. Reading the current task definition
2. Replacing only the `App` container image
3. Removing response-only ECS metadata
4. Registering the new revision
5. Updating the affected ECS service

## Destroy the application environment

Destroy the ShopMesh application stacks when the environment is no longer needed:

```bash
npx cdk destroy --all --force
```

The CDK bootstrap stack named `CDKToolkit` is separate from ShopMesh and should normally remain in place. Do not remove it as part of an application teardown.

CDK or AWS may retain stateful resources or create deletion snapshots. After destroying the application stacks, check `us-east-1` for leftovers:

- Aurora clusters and cluster snapshots
- DynamoDB tables
- ECR repositories and container images
- CloudWatch log groups
- CloudWatch alarms
- Lambda functions
- SNS topics and subscriptions
- Secrets Manager secrets
- ECS clusters and services
- Load balancers, target groups, NAT gateways, and Elastic IPs

Delete retained resources only after confirming that the environment and its evidence are no longer needed. Retained ECR images, DynamoDB tables, CloudWatch logs, and database snapshots can continue to create storage costs.

## Recreate after teardown

The environment can be recreated from the CDK source after teardown:

```bash
npm install
npm run build
npm test
npx cdk deploy --all --require-approval never
```

The application images must also exist in ECR before ECS tasks can start. In normal operation, the GitHub Actions workflows build and push the images before updating the ECS services.

## Relationship to the root README

The root [`README.md`](../README.md) explains the full ShopMesh story and includes the complete evidence set. This document is intentionally operational and infrastructure-focused. Use it when you need to:

- Understand which stack owns a resource
- Run CDK tests or synthesize templates
- Review a deployment diff
- Deploy or destroy the AWS environment
- Diagnose stack dependencies
- Clean up retained resources after teardown
