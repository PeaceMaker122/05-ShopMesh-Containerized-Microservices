# ShopMesh Project Brief

## Project overview

ShopMesh began as an online retail platform where product browsing and shopping cart management lived together in a tightly coupled application. It will become a containerized microservices platform in which Catalog and Cart can be deployed, scaled, secured, and operated independently.

The project demonstrates that transformation from a monolithic application into a platform with independent deployment, independent scaling, private service-to-service communication, secure data access, automated delivery, and operational feedback.

The implementation uses Node.js services, Docker, AWS CDK, Amazon ECS on Fargate, Aurora Serverless v2 PostgreSQL, DynamoDB, ECS Service Connect, GitHub Actions, and CloudWatch-based observability.

## The problem

Catalog and Cart have different responsibilities and different traffic patterns, but a monolithic deployment treats them as one unit. That creates three practical problems:

1. A change to one feature requires the whole application to be rebuilt and deployed.
2. A traffic spike in one area requires capacity for the entire application, even when the other area is quiet.
3. When something fails, application logs, infrastructure signals, and deployment history are not naturally separated by service.

ShopMesh needs a platform where Catalog and Cart can evolve independently without sacrificing a reliable customer-facing request path.

## Project goals

The project has five primary goals:

- Separate Catalog and Cart into focused microservices with clear ownership boundaries.
- Deploy and scale each service independently on AWS.
- Provide secure, private service-to-service communication from Cart to Catalog.
- Automate image delivery and ECS deployments without storing long-lived AWS credentials.
- Detect failures quickly and provide enough context for a human to investigate and recover.

## Scope

### Application services

The platform contains two services:

- **Catalog:** serves product information through `/product/:id` and owns the product data.
- **Cart:** manages carts through `/cart/:id/items` and calls Catalog to retrieve current product names and prices before adding items.

Both services expose a health endpoint and run as separate containers. Cart calls Catalog through the stable internal name `catalog`, not through the public load balancer.

### Data ownership

Each service owns a data store suited to its access pattern:

- **Catalog:** Aurora Serverless v2 PostgreSQL for relational product data.
- **Cart:** DynamoDB for cart records keyed by `cartId`.

Database credentials are generated and stored in AWS Secrets Manager. Credentials are injected into the Catalog task at runtime rather than hardcoded in source code or task definitions.

### Infrastructure

AWS CDK defines the complete application environment:

- A VPC spanning multiple Availability Zones
- Public subnets for the Application Load Balancer
- Private subnets for ECS tasks and databases
- ECS on Fargate
- Amazon ECR repositories for both services
- Aurora Serverless v2 and DynamoDB
- ECS Service Connect private service discovery
- HTTPS routing through an Application Load Balancer
- Independent ECS services and target-tracking scaling policies
- IAM roles for runtime access and deployment access

### Delivery

GitHub Actions provides the delivery path. A service change builds a new Docker image, pushes it to ECR, registers a new ECS task-definition revision, and updates only the affected ECS service.

GitHub authenticates to AWS through OIDC and short-lived STS credentials. Separate staging and production roles limit which workflows can deploy and which resources they can access.

### Operations

The operational layer includes:

- CloudWatch container logs
- ECS Container Insights
- Alarms for ALB errors, unhealthy tasks, and Cart-to-Catalog failures
- EventBridge rules for alarm transitions
- A triage Lambda that gathers recent context
- Amazon Bedrock for a concise incident hypothesis
- SNS delivery of the AI-assisted summary to a human reviewer

The AI summary supplements the raw alarm. It does not perform automatic remediation.

## Architecture narrative

The request path is:

```text
User
  ↓
HTTPS Application Load Balancer
  ├── /product/* → Catalog service → Aurora PostgreSQL
  └── /cart/*    → Cart service → DynamoDB
                         ↓
                 ECS Service Connect
                         ↓
                   Catalog service
```

The supporting delivery and operations paths are:

```text
Git push
  ↓
GitHub Actions with OIDC
  ↓
Docker build and ECR push
  ↓
ECS task-definition revision
  ↓
Independent service deployment
```

```text
CloudWatch alarm
  ↓
EventBridge
  ↓
Triage Lambda
  ↓
Amazon Bedrock
  ↓
SNS notification
```

## Design principles

### Independent service ownership

Catalog and Cart have separate code, containers, ECS services, data stores, IAM roles, logs, health checks, and scaling policies. This keeps changes and failures localized.

### Infrastructure as code

The network, data layer, compute layer, routing, IAM, delivery roles, alarms, and triage resources are defined in AWS CDK. The infrastructure can be synthesized, tested, reviewed, deployed, and destroyed from version-controlled source.

### Least privilege

Runtime roles are scoped to the data and services each application needs. Deployment roles are separate from runtime roles and use the minimum permissions required by the CI/CD workflow.

### Secure service communication

Cart reaches Catalog through ECS Service Connect inside the private VPC. The public ALB is reserved for user-facing routes.

### Observable failure handling

A production-style platform must show more than a successful request. Centralized logs, health checks, alarms, deployment rollback, and human-reviewed triage are part of the system design.

## Success criteria

The project is successful when:

1. Catalog and Cart can be built, deployed, scaled, and updated independently.
2. Cart can retrieve product data from Catalog through ECS Service Connect.
3. Catalog uses Aurora PostgreSQL and Cart uses DynamoDB with no hardcoded database credentials.
4. A service change can move from GitHub Actions to ECR and ECS without stored long-lived AWS keys.
5. HTTPS routes requests to the correct service through the ALB.
6. Logs and metrics make the service-to-service request path visible.
7. A deliberately broken deployment fails its health check and rolls back through the ECS deployment circuit breaker.
8. A controlled application failure produces a CloudWatch alarm, invokes the triage Lambda, and sends an AI-assisted SNS summary.
9. The complete environment is reproducible from the CDK source.

## Out of scope

This project does not attempt to provide every concern required by a large retail platform. The following are intentionally left for future evolution:

- A full frontend application
- Payments and order fulfillment
- Multi-region active-active deployment
- Blue/green traffic shifting with CodeDeploy
- A full service mesh for a large service fleet
- WAF rules and advanced edge protection
- Distributed tracing and long-term analytics pipelines
- Multi-account platform governance

These are scale considerations rather than gaps in the core demonstration.

## Expected outcomes

The completed platform demonstrates that a microservices migration is more than splitting one application into two containers. It also requires:

- Clear service ownership
- A private service communication model
- Independent deployment and scaling
- Secure credentials and permissions
- Reproducible infrastructure
- Centralized operational visibility
- Tested failure behavior and recovery

The result is a small but complete reference platform for running independently deployable Catalog and Cart services with a clear path toward larger-scale production practices.

## Further scale considerations

If ShopMesh grows beyond a small service fleet, the platform could evolve toward:

- AWS App Mesh or another full service mesh for advanced traffic policy and telemetry
- CodeDeploy blue/green deployment for progressive traffic shifting
- AWS WAF in front of the ALB
- Distributed tracing and service-level objectives
- Stronger environment isolation across AWS accounts
- Database migration tooling, backups, restore testing, and read scaling
- Additional deployment approvals, policy checks, and progressive delivery controls
