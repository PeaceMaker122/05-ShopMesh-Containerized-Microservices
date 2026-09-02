# Decisions & Reasoning

## Phase 0 (first-off decisions)

**Context:** This project breaks ShopMesh's monolithic catalog + cart into two independently deployable, independently scalable microservices, with full operational concerns (security, delivery, observability) handled from day one. All infrastructure is defined in AWS CDK.

**1. Decision: IaC-first.**

Infrastructure is defined in CDK from the start and extends as services are built. This is a greenfield project with no existing imports, so there is nothing to reverse-engineer into CDK. Writing CDK first costs nothing and keeps the whole system one deployable unit.

**2. Architecture choice: Fargate instead of EC2 launch type with Auto Scaling.**

We use Fargate because there are no EC2 instances for us to patch, manage, or do capacity planning for, and AWS handles the underlying compute.

**3. Data choice: Aurora Serverless v2 (PostgreSQL) instead of a fixed-size RDS instance for Catalog.**

Aurora Serverless v2 scales its own capacity up and down automatically, so a low-traffic project isn't billed for a fixed-size database sitting idle around the clock. This is the same "right-sized cost" theme as the rest of the project.

**4. Language choice: Node.js for both services.**

Node is a natural fit for small, fast HTTP microservices served through the ALB (using `express`). One language across both services keeps things simple.

**5. Local Compose file at the root.**

A `docker-compose.yml` defines both services for local development. Cart calls Catalog over the network internally, so testing the add-to-cart flow on a laptop requires both containers running and able to reach each other, exactly the multi-container use case Compose is built for. It is a local convenience only; production orchestration is ECS's job.

**6. Reusable CI/CD workflow.**

Instead of two near-identical `deploy-staging.yml` / `deploy-production.yml` files, the build -> push -> deploy steps live in one reusable workflow. Staging and production become thin wrappers that call it with a target environment. This keeps the pipeline logic in one place so it can't silently drift between environments.

**7. CDK stack layout.**

Rather than one flat stack or an over-fragmented set, we split by concern:

- `network-stack`: VPC, subnets, ALB, Service Connect namespace
- `catalog-stack`: Catalog's ECR repo, ECS task/service, Aurora, IAM roles
- `cart-stack`: Cart's ECR repo, ECS task/service, DynamoDB, IAM roles
- `ops-stack`: observability (Container Insights, alarms, triage Lambda, SNS) + CI/CD OIDC role

Keeping catalog and cart as separate stacks mirrors their independence; collapsing observability and CI/CD into one ops stack avoids excessive fragmentation.

**8. Stack-dependency handling.**

These stacks have a strict bottom-up dependency order (network, catalog/cart, ops). Because resources are passed between stacks, CDK/CloudFormation derives the deployment order automatically, so `cdk deploy '*'` deploys them in the correct sequence without manual steps. This is the deliberate mitigation for the cross-stack coupling that multi-stack designs introduce.

**9. Consequences.**

- Fargate: no instance patching, no capacity planning; slightly less low-level control than EC2.
- Aurora Serverless v2: near-zero cost when idle, but less predictable cost under sustained heavy load than a fixed-size instance.
- Multi-stack: cleaner separation of concerns and per-service readability, at the cost of cross-stack reference wiring (mostly automated by CDK).
- Reusable workflow: single source of truth for pipeline logic, less duplication, steeper initial setup than copy-pasting two workflows.

---
