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

## Phase 0.5 (Architecture Design and Diagram)

**1. What this task is solving**

Design the target-state architecture before implementation, so the build follows a clear blueprint that maps the CI/CD and delivery layers, the internal service-to-service layer, and the observability layer, and establishes the full component layout up front.

**2. What I did**

- Designed the target-state architecture in Excalidraw (`architecture/Target-state-architecture.excalidraw`).
- The diagram shows the full system inside an AWS Cloud boundary (Region, two AZs for redundancy), with the GitHub CI/CD side outside on the left.
- It covers the CI/CD and deployment flow (push to GitHub, GitHub Actions, Docker build, push to ECR with scanning, and OIDC auth to AWS via STS), the traffic flow (Users to ALB to per-AZ endpoints into the services), and the internal service-to-service layer (Cart to Catalog via Service Connect, not the ALB), each service with its own database.
- Three callout boxes annotate the delivery/service-to-service summary, the S3 static frontend hosting note (with Route 53 and ACM), and the observability chain (CloudWatch to EventBridge to Lambda to Bedrock to SNS), all outside the main request path.

**3. Why I did it**

- Design before implement: a clear blueprint catches issues before any code is written.
- Visualizing the CI/CD, delivery, service-to-service, and observability layers makes the data flow and each component's role explicit and reviewable.
- The diagram doubles as the architecture diagram needed for the final README.

**4. What I rejected**

- Starting implementation without a design (risks building the wrong thing).
- A single-AZ setup without redundancy.
- Not using Service Connect for Cart to communicate with Catalog to pull in the necessary data; the internal call goes through Service Connect instead of the ALB.
- Treating the frontend or the observability pipeline as part of the main request path; both are supporting layers.

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
 
### 2b. ECR repositories

**1. What this task is solving**

Give each service its own container image registry, with automated vulnerability scanning on push.

**2. What I did**

- Created `lib/catalog-stack.ts` and `lib/cart-stack.ts`, each defining an ECR repository (`shopmesh-catalog` and `shopmesh-cart`) with `imageScanOnPush: true`.
- Wired both stacks into `bin/infrastructure.ts` with the shared environment.

**3. Why I did it**

- Image scanning on push automatically checks every uploaded image against known vulnerabilities before it is ever deployed.
- Co-locating each repo in its service stack keeps ECR next to the ECS tasks that consume it.

**4. What I rejected**

- Putting both repos in a single shared stack location (they belong with their services).
- Scanning only on demand rather than on push (on-push makes scanning automatic and non-optional).

---

### 2c. Data layer (Aurora Serverless v2 and DynamoDB)

**1. What this task is solving**

Give each service a purpose-matched database in the private subnets, with credentials handled securely from creation, rather than one shared database or credentials stored in plaintext.

**2. What I did**

- **Catalog:** added an Aurora Serverless v2 (PostgreSQL 16.11) cluster to `catalog-stack.ts`, running in the private subnets. CDK auto-generates the credentials and stores them in Secrets Manager from creation, and the secret is wired to the cluster as the target.
- **Cart:** added a DynamoDB table (`shopmesh-carts`) to `cart-stack.ts` with a `cartId` partition key and `PAY_PER_REQUEST` billing.
- Updated `bin/infrastructure.ts` to pass the VPC from the network stack into the catalog stack, establishing the cross-stack dependency.

**3. Why I did it**

- Aurora Serverless v2 scales its own capacity up and down, so an idle demo project is not billed for a fixed-size database.
- DynamoDB matches the key-value access pattern of cart data (a user/cart ID with items), with no relational joins needed.
- Auto-generated Secrets Manager secrets mean no database password is ever set or hardcoded manually.
- Private subnets keep both databases unreachable from the internet.

**4. What I rejected**

- A shared database (each service owns its data).
- A fixed-size RDS instance (would bill for idle capacity).
- Hardcoding or manually passing database credentials (we let CDK generate the secret).
- Isolated subnets for the database; we use the private-with-egress subnets the VPC already provides, which are still private and not internet-reachable.

---

### 2d. ECS cluster and task definitions

**1. What this task is solving**

Provide the orchestration layer: one shared ECS cluster running on Fargate, and one task definition per service, each with its own least-privilege IAM roles so a service can only reach what it needs.

**2. What I did**

- Added a shared ECS cluster (`network-stack.ts`), using Fargate, and passed it to both service stacks.
- **Catalog:** added a Fargate task definition (`catalog-stack.ts`) with a container on port 3000 from its ECR repo. Its task role is scoped to only read the Aurora database secret from Secrets Manager; its execution role pulls the image from ECR and writes CloudWatch logs.
- **Cart:** added a Fargate task definition (`cart-stack.ts`) with a container on port 3001 from its ECR repo, plus `CATALOG_URL=http://catalog:3000` for the Service Connect call later. Its task role is scoped to read/write only its own DynamoDB table; its execution role pulls the image and writes logs.
- Wired the shared cluster into both stacks via `bin/infrastructure.ts`.

**3. Why I did it**

- Fargate removes EC2 patching and capacity planning.
- Separate task IAM roles per service, scoped to only what that service needs, means Cart's role cannot touch Catalog's database credentials or Aurora cluster, and vice versa.
- Separate execution roles are the standard ECS setup (ECS pulls the image and ships logs), kept distinct from the app task role.
- `CATALOG_URL` already points at the Service Connect service name, so the app code is aligned with the target architecture.

**4. What I rejected**

- A single shared task IAM role (would not be least privilege).
- Using one execution role across services with broad permissions.
- Setting static IPs or hardcoded endpoints; we use the Service Connect service name.

---

### 2e. ECS Service Connect

**1. What this task is solving**

Make service discovery real: let Cart reach Catalog by a short, stable name over the network, with fast failover, instead of hardcoding an IP or using plain DNS that can go stale.

**2. What I did**

- Added a Cloud Map private DNS namespace (`shopmesh.local`, VPC-scoped) in the network stack for ECS Service Connect.
- Created the ECS Fargate services that host the two task definitions, running in the private subnets.
- Enabled Service Connect on both services with the namespace. Catalog registers under the short name `catalog` (port 3000); Cart registers as `cart` (port 3001).
- Gave each container a named port mapping (`app`) required to use Service Connect.
- Cart's existing `CATALOG_URL=http://catalog:3000` now resolves through Service Connect to a healthy Catalog task.

**3. Why I did it**

- Cart needs to fetch product data from Catalog to price items; Service Connect is the current recommended AWS way for ECS services to find and call each other by short name.
- Service Connect fails over faster than plain DNS-based discovery if a Catalog task goes down, and gives built-in inter-service traffic metrics.
- Private DNS namespace keeps discovery scoped to the VPC.

**4. What I rejected**

- Plain Cloud Map DNS-based discovery without Service Connect's fast failover.
- Hardcoded IP addresses or public DNS names for internal service calls.
- An HTTP namespace; we use a private DNS namespace, which is the standard fit for VPC-scoped ECS Service Connect.

---

### 2f. ALB path-based routing and HTTPS

**1. What this task is solving**

Route visitor traffic at the single entry point to the right service, and serve it over HTTPS, so the whole system is reachable at one domain with the two services behind one load balancer.

**2. What I did**

- Created an ACM certificate for `stiaan.click` (plus `*.stiaan.click`) DNS-validated through the Route 53 hosted zone I own, referenced by its real zone ID (`fromPublicHostedZoneAttributes`) rather than a live lookup.
- Added an HTTPS listener on 443 with that certificate, and changed the HTTP listener on 80 to redirect all traffic to HTTPS.
- **Catalog:** created a target group (port 3000, `/health` health check), attached the Fargate service, and added a listener rule matching `/product*` (priority 10).
- **Cart:** created a target group (port 3001, `/health`), attached the service, and added a listener rule matching `/cart*` (priority 20).
- Wired the HTTPS listener into both service stacks.

**3. Why I did it**

- One ALB with path-based routing keeps both services behind one entry point while keeping them independent behind it.
- A real owned domain with DNS validation avoids the ACM validation failure a placeholder domain causes, and using a real zone ID keeps synthesis deterministic.
- HTTP to HTTPS redirect ensures all traffic is encrypted.
- Health checks on `/health` let the ALB only route to healthy tasks.

**4. What I rejected**

- A placeholder/unowned domain for the certificate.
- Using a live `HostedZone.fromLookup` (breaks offline synth and tests).
- HTTP-only traffic.
- Calling `listener.addTargetGroups()` from another stack, which created the rule in the listener's stack and caused a cross-stack dependency cycle; instead I create each `ApplicationListenerRule` in its own service stack.

---

### 2g. Auto scaling

**1. What this task is solving**

Let each service scale its number of tasks up and down on its own, based on its own traffic, rather than scaling as one monolith unit.

**2. What I did**

- Added a target-tracking scaling policy to each Fargate service that scales on average CPU utilization at 70%.
- Gave the two services independent ranges: Catalog scales between 1 and 4 tasks; Cart scales between 1 and 3 tasks.

**3. Why I did it**

- This is the real payoff of splitting the monolith: Catalog and Cart scale independently instead of over/under-provisioning as one unit.
- CPU target-tracking is the straightforward, AWS-predefined scaling metric.
- Independent min/max lets us demonstrate the two services responding differently under simulated load.

**4. What I rejected**

- A shared scaling policy or identical ranges for both services (would defeat the point of independent scaling).
- Scaling on a custom metric at this stage; CPU target-tracking is enough.

---

## Phase 2 summary

Completed the core infrastructure: VPC and networking, ECR registries, the data layer (Aurora Serverless v2 and DynamoDB), ECS on Fargate with scoped IAM roles, ECS Service Connect, the ALB with HTTPS path routing, and per-service auto scaling. The infrastructure is defined entirely in CDK and synthesizes cleanly, but has not yet been deployed.

---

## Phase 3 (CI/CD)

### 3a. GitHub Actions OIDC role

**1. What this task is solving**

Let GitHub Actions authenticate to AWS without storing long-lived keys, so builds can push images to ECR and update the ECS services on push, scoped to exactly this project.

**2. What I did**

- Created `lib/ops-stack.ts`, which hosts the CI/CD and (later) observability pieces. It defines a GitHub OIDC provider and a role GitHub Actions can assume.
- Scoped the role's trust to this exact repo with an exact-match `sub` condition: `repo:PeaceMaker122@214525680/05-ShopMesh-Containerized-Microservices@1352806286:ref:refs/heads/*`, plus `aud: sts.amazonaws.com`.
- Granted the roles just enough permissions: ECR push to both repositories, and updating both ECS services.
- Gave both roles explicit, stable names (`shopmesh-staging-deploy`, `shopmesh-production-deploy`) so the workflows can reference a predictable ARN instead of a generated one, the same way the cluster, services, and task definitions are named.
- Added an ops-stack test asserting the provider, the trust policy, and the scoped ECR/ECS permissions.

**3. Why I did it**

- OIDC removes stored AWS keys, so no long-lived credential is kept in GitHub, and GitHub authenticates to AWS through a short-lived token exchange.
- GitHub's `sub` claim now embeds numeric owner and repo IDs; an exact-match condition on both is the only reliable way to scope trust to this repo. The old simple `repo:owner/repo` format no longer matches.
- We use two roles, one per environment, each with an exact-match `sub` for its event type (staging on pull requests, production on push to main). This keeps least privilege: a role can only be assumed by the workflow that needs it, and neither role accepts a wildcard.
- Narrow ECR + ECS permissions mean the role can deploy this project and nothing else.

**4. What I rejected**

- Storing long-lived AWS access keys in GitHub secrets.
- A broad trust policy (e.g. matching any repo under the account, or a wildcard sub without the numeric IDs).
- A single wildcard `sub` covering both event types; we split into two exact-match roles per environment for least privilege.
- Granting broad admin permissions; we scope to exactly the two repos and two services.

---

### 3b. Reusable deploy workflow

**1. What this task is solving**

Run the build, push, and deploy steps once in a shared reusable workflow, so staging and production call the same logic instead of maintaining two near-copies that can drift.

**2. What I did**

- Created `.github/workflows/deploy-service.yml`, a reusable workflow that takes the service, ECR repository, ECS service, and image tag as inputs, plus the AWS account/region as secrets.
- It assumes the OIDC role, logs in to ECR, builds the service image, tags it with the commit SHA, and pushes it.
- It registers a new task definition revision pointing at the new image, then updates the ECS service to that revision with a forced new deployment.
- Set stable names in CDK for the pipeline to reference: cluster `shopmesh-cluster`, service names `catalog-service`/`cart-service`, and task definition families `catalog-service`/`cart-service`.

**3. Why I did it**

- A single source of truth for the delivery logic avoids the pipeline drift failure mode that duplicated workflows create.
- Re-tagging the task definition with the new image means the deployment actually rolls out the just-built image.
- Stable resource names let the workflow reference the cluster, service, and task definition reliably instead of guessing at generated names.

**4. What I rejected**

- Duplicating the build/deploy steps in each environment workflow.
- Relying on AWS-generated resource names in the workflow (they change if the stack is recreated).
- Using the AWS CLI's own assumptions about image/task-definition naming.

---

### 3c. Staging workflow (on pull request)

**1. What this task is solving**

Deploy changed service(s) to staging on every pull request, so changes are validated in a private environment before reaching production.

**2. What I did**

- Created `.github/workflows/deploy-staging.yml` triggered on pull requests.
- Added a path-filter step that detects whether the catalog and/or cart service files changed (`services/catalog/**`, `services/cart/**`).
- Calls the reusable workflow only for the service(s) that actually changed, tagging the image with the PR head SHA.

**3. Why I did it**

- Staging catches mistakes before real visitors see them.
- Path filtering deploys only what changed, so an unrelated change to one service does not redeploy the other.

**4. What I rejected**

- Deploying both services on every PR regardless of what changed.
- Deploying directly to production from a pull request.

---

### 3d. Production workflow (on merge to main)

**1. What this task is solving**

Deploy changed service(s) to production when code is merged to main, as a `git push`, with ECS's built-in deployment behavior handling rollback.

**2. What I did**

- Created `.github/workflows/deploy-production.yml` triggered on pushes to `main` (path-filtered to the services).
- Uses the same path-filter detection to deploy only the affected service(s), tagging with the merge commit SHA.

**3. Why I did it**

- Production ships from the tested staging state on merge, not from a laptop.
- ECS' rolling deployment health-checks new tasks and rolls back if they fail, so we rely on that rather than custom rollback logic.

**4. What I rejected**

- Manual or laptop-based production deploys.
- Building custom rollback logic; we use ECS's built-in deployment circuit breaker behavior.

---

### 3e. Permissions for ECS task-definition deployments

**1. What this task is solving**

Allow the reusable GitHub Actions workflow to create a new ECS task-definition revision and deploy it without granting broad AWS permissions.

**2. What I did**

- Added permission to read task definitions and register new revisions. AWS requires `Resource: "*"` for these ECS API actions, so the wildcard is limited to these two actions.
- Allowed the deploy roles to pass only the four existing service task and execution roles.
- Added tests for the task-definition and role-passing permissions, then updated OpsStack.

**3. Why I did it**

- The workflow reads the current task definition, changes only the image, registers a revision, and updates the ECS service.
- Each permission matches one required workflow action. Service updates are scoped to the two services, role passing is scoped to the four task roles, and the ECS task-definition actions use the wildcard only because AWS does not support resource-level scoping for these API calls.

**4. What I rejected**

- Granting `ecs:*`, `iam:*`, or administrator access to GitHub Actions.
- Allowing the workflow to pass arbitrary IAM roles.
- Keeping a policy that could update services but could not complete the task-definition deployment flow.

---

## Phase 4 (Observability and AI-Assisted Triage)

### 4a. Container Insights and logging

**1. What this task is solving**

Give the team a purpose-built view of the ECS services (CPU/memory per service, task counts, health) and centralize both services' logs so a failure can be traced across them.

**2. What I did**

- Enabled Container Insights on the ECS cluster.
- Added a CloudWatch log driver to both the Catalog and Cart containers, with distinct stream prefixes (`catalog`/`cart`), so each service's logs land in clearly named log groups.

**3. Why I did it**

- Container Insights is CloudWatch's purpose-built ECS view, instead of hunting raw metrics.
- Centralized, clearly named log groups let a failure in Cart's call to Catalog be traced across both services.

**4. What I rejected**

- Leaving logging off or shipping logs to separate, unnamed destinations.

---

### 4b. CloudWatch alarms

**1. What this task is solving**

Surface real failure signals so the team finds out something broke, rather than only after a customer reports it.

**2. What I did**

- Added an unhealthy-task alarm per service (Catalog and Cart).
- Added an ALB 5xx alarm.
- Added a Cart to Catalog failure-rate alarm on a custom metric (`ShopMesh/CatalogCallFailure`)that Cart's app now emits on failed Catalog calls.

**3. Why I did it**

- Unhealthy tasks and ALB 5xx are standard infra signals.
- The Cart to Catalog failure rate is the one signal plain infrastructure metrics won't surface on their own, so it is exposed as a custom metric from Cart's application code.

**4. What I rejected**

- Relying only on infrastructure metrics, which would miss the service-to-service failure signal.

---

### 4c. AI-assisted triage pipeline

**1. What this task is solving**

When an alarm fires, give the team a fast, plain-English hypothesis of what likely happened, alongside the raw alarm, so a human can investigate faster.

**2. What I did**

- Added an SNS topic (`shopmesh-triage`) for the AI summary, kept separate from any raw-alarm topic.
- Added a triage Lambda(Node 24) that, on an alarm, pulls the last few minutes of the affected service's logs, asks Amazon Bedrock (Claude via `invoke_model` with the Anthropic Messages format, using an inference profile ID) for a short hypothesis, and publishes it to the SNS topic.
- Added an EventBridge rule per alarm that triggers the Lambda on ALARM state.

**3. Why I did it**

- The AI summary is sent alongside the raw alarm, never replacing it, and never taking any automatic action; a person still decides what to do.
- Using `invoke_model` with the Anthropic Messages format avoids relying on a newer SDK method that may not exist on the runner.
- Using an inference profile ID (rather than a raw model ID) is required for on-demand throughput.

**4. What I rejected**

- The AI taking any automatic remediation action; it only writes a summary a human reads.
- Over-scoping the Bedrock permission to a specific region; we grant a single `bedrock:InvokeModel` on all resources, since the inference profile can route cross-region.

---

## Phase 5 (Integration and Testing) prep

### 5a. DNS records and HTTPS wiring

**1. What this task is solving**

Make the domain resolve to the load balancer so HTTPS traffic actually reaches the services, rather than leaving the domain pointing nowhere.

**2. What I did**

- Added an A/alias record in CDK pointing `stiaan.click` to the ALB, and a second for `www.stiaan.click`.
- The ACM certificate validation records are auto-created by CDK via DNS validation against the hosted zone, so no manual validation records are needed.

**3. Why I did it**

- The domain must resolve to the ALB for the HTTPS endpoint to work.
- Doing it in CDK keeps the whole system defined as code.

**4. What I rejected**

- Creating the DNS records manually outside the infrastructure code.

---

### 5b. Wire services to their real databases

**1. What this task is solving**

Replace the in-memory placeholder data stores with the real databases, so the services return real, DB-backed data and the architecture matches its intended end state.

**2. What I did**

- **Catalog:** added a `pg` client, a database module that reads the injected Aurora secret, connects, creates the `products` schema, and seeds three products. The task definition injects the Aurora secret via CDK `secrets` (`DB_CREDENTIALS`) plus a `DB_NAME` env var. The `/health` endpoint now checks database connectivity and returns 503 if the DB is unreachable.
- **Cart:** added the DynamoDB SDK, rewrote the cart store to read/write carts to the `shopmesh-carts` table keyed by `cartId`, and passed a `CARTS_TABLE` env var to the task.

**3. Why I did it**

- The project's success criteria call for real, DB-backed services, and the evidence of the infrastructure is stronger with the real data layer.
- The task roles already had the scoped database permissions, so the wiring only needed the connection config and code.

**4. What I rejected**

- Keeping the in-memory stores for testing (would not exercise the real data layer nor match the end state).

---

### 5c. Deploy and stabilize the Catalog service

**1. What this task is solving**

Deploy the Catalog service successfully and ensure ECS replaces unhealthy tasks correctly.

**2. What I did**

- Configured the Fargate Service Connect proxy with a separate ingress port and allowed that port in the service security group, so the ALB could reach the application directly on port 3000.
- Fixed the Catalog health endpoint so it imports the database connection pool that it uses.
- Rebuilt and pushed the corrected image, then deployed CatalogStack independently.
- Confirmed the stack completed and the ALB target became healthy with one running task.

**3. Why I did it**

- The Service Connect proxy was initially able to intercept the application port, so the proxy needed its own ingress port before ALB traffic could reach the app directly.
- After that routing issue was corrected, the application was starting and connecting to Aurora, but the missing import caused `/health` to return 503, so ECS repeatedly stopped otherwise-running tasks.
- Deploying the service independently made the result easier to verify before deploying the remaining stacks.

**4. What I rejected**

- Leaving the Service Connect proxy on the same port as the application when the ALB needs direct access to that port.
- Treating the ECS health-check loop as only an infrastructure networking failure without checking both the application logs and source code.
- Deploying all service and operations stacks together before the Catalog service was stable.

---

### 5d. Use unique Service Connect port mapping names

**1. What this task is solving**

Allow both services to register in the shared Service Connect namespace without a naming conflict.

**2. What I did**

- Changed the Cart container port mapping and Service Connect port mapping name from `app` to `cart`.
- Updated the infrastructure test to match the unique Cart mapping.
- Redeployed CartStack and confirmed its ALB target became healthy with one running task.
- Deployed OpsStack after both services were stable.

**3. Why I did it**

- Service Connect uses the port mapping name when registering a service in the namespace, so both services cannot use the same name.
- Unique names keep Catalog and Cart independently discoverable while preserving Cart's `cart` DNS name and port 3001.

**4. What I rejected**

- Removing Service Connect from Cart.
- Reusing the shared `app` port mapping name for both services.
- Deploying OpsStack before the service stacks were confirmed healthy.

---
