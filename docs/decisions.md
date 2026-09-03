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

## Phase 1 (Containerizing the Services)

### 1. Catalog and Cart application code

**1. What this task is solving**

Write the two Node/Express microservices that the Dockerfiles package, so each service is a small HTTP app: Catalog serves product data and Cart serves cart data while calling Catalog internally to price items.

**2. What I did**

- Created `services/catalog` and `services/cart`, each a Node/Express app with its own `package.json`.
- Catalog: in-memory product store (`src/products.js`), Express server with `/health` and `/product/:id` (`src/server.js`), port 3000.
- Cart: in-memory cart store (`src/cart-store.js`), a Catalog client (`src/catalog-client.js`) that calls `http://catalog:3000` using the service name, and an Express server with `/health`, `/cart/:id`, and `POST /cart/:id/items` (`src/server.js`), port 3001.
- The in-memory stores are deliberate placeholders; they are replaced by Aurora (Catalog) and DynamoDB (Cart) once the data layer is built.

**3. Why I did it**

- Cart calling Catalog by the service name `catalog` is the exact behavior Service Connect will provide in production, so the code already matches the target architecture.
- Splitting each service into a server and a stores/client module keeps the data-access seams ready for the real databases later.

**4. What I rejected**

- Hardcoding an IP address for Catalog; we use the stable service name instead.
- Adding an HTTP client dependency; Node's built-in `fetch` is enough.

### 2. Multi-stage Dockerfiles, non-root user

**1. What this task is solving**

Package each service into a small, secure container image that behaves identically anywhere it runs.

**2. What I did**

- Added a multi-stage Dockerfile per service: a `node:20-alpine` builder stage installs production dependencies, then a slim runtime stage copies only the finished `node_modules` and `src`.
- Both images run as the non-root `node` user (`USER node`).
- Added a root `compose.yaml` defining both services so they run together locally; Cart's `CATALOG_URL` points at the Compose service name `catalog`.

**3. Why I did it**

- Multi-stage keeps the deployed image small and excludes build tools (and their vulnerabilities) from production.
- Non-root reduces the blast radius if a container is ever compromised.
- Compose lets both services run together on a laptop so the Cart to Catalog call can be tested before AWS.

**4. What I rejected**

- A single-stage Dockerfile that ships the full Node runtime plus build tooling.
- Running the container as `root` (the default unless overridden).

### 3. Local build and verification

**1. What this task is solving**

Prove both containers build and run cleanly before any AWS involvement.

**2. What I did**

- Built both images with `docker compose build` (pulled `node:20-alpine`, installed deps, verified the multi-stage output).
- Started them with `docker compose up -d` and confirmed both were Up with correct port mappings.
- Verified `/health` on both returned `{"status":"ok"}` and `/product/1` returned the product JSON.
- Exercised the add-to-cart flow: `POST /cart/1/items` with product 1 returned the item populated with name and price, and total `179.98` (89.99 x 2), proving Cart called Catalog internally for the product data.

**3. Why I did it**

- Catching issues locally (build, runtime, networking) avoids burning time and money on AWS deployments.
- Confirming the Cart to Catalog call locally proves the service-to-service interaction works before the real Service Connect wiring exists.

**4. What I rejected**

- Skipping local verification and going straight to AWS.

---

## Phase 2 (AWS CDK Infrastructure)

### 2a. Network stack (VPC, ALB, HTTP listener)

**1. What this task is solving**

Provide the network foundation: a VPC with public subnets for the load balancer and private subnets for the ECS tasks and both databases, across at least two Availability Zones for resilience, plus the single public entry point (the ALB) with path-based routing once the service stacks attach their target groups.

**2. What I did**

- Created `lib/network-stack.ts` with a VPC across two AZs, one NAT gateway, and an internet-facing Application Load Balancer.
- Added an HTTP listener on port 80 with a default 503 fixed response so requests matching neither `/product` nor `/cart` get a clear "no matching service" response.
- Set the region to `us-east-1` (account from `CDK_DEFAULT_ACCOUNT`).

**3. Why I did it**

- Public/private subnet split keeps everything except the ALB unreachable from the internet, matching the security model.
- Two AZs give the load balancer and services resilience.
- The default 503 lets the listener synthesize before the real path rules exist, without hardcoding service targets.

**4. What I rejected**

- A single flat stack approach (I split stacks by concern).
- Leaving the region as the CLI default; I pin `us-east-1` deliberately.
- Leaving the listener without a default action (it fails to synthesize).

---
