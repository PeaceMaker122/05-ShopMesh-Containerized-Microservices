# ShopMesh

ShopMesh is a containerized microservices platform for a product catalog and shopping cart. The project starts with a monolithic problem: catalog and cart responsibilities are coupled, so a change or traffic spike in one area affects the whole application. The goal was to separate those responsibilities into independently deployable, independently scalable services while keeping the system secure, observable, and reproducible.

The result is a Node.js and Express application running as two Docker containers locally and as two Amazon ECS services on AWS Fargate in production. Catalog owns product data in Aurora PostgreSQL. Cart owns cart data in DynamoDB and calls Catalog internally through ECS Service Connect. AWS CDK defines the infrastructure, GitHub Actions provides CI/CD through OIDC, and CloudWatch, EventBridge, Lambda, Bedrock, and SNS provide the operational feedback loop.

## Video Walkthrough

Click the image to open the corresponding video.

### Part 1

[![ShopMesh video walkthrough, part 1](screenshots/Video%20Wakthroughs/Shopmesh%20Containerized%20Microservices%20-%20Part%201.png)](https://www.loom.com/share/3431ba32294b4553bb41f35ae114d3e0)

### Part 2

[![ShopMesh video walkthrough, part 2](screenshots/Video%20Wakthroughs/ShopMesh%20Containerized%20Microservices%20-%20Part%202.png)](https://www.loom.com/share/92b5a3de54c94dcf97a226241f6a6578)

## What the project demonstrates

- A monolith decomposed into Catalog and Cart microservices
- Local multi-container development with Docker Compose
- AWS CDK infrastructure defined as code
- ECS on Fargate without managing EC2 instances
- Aurora Serverless v2 for Catalog and DynamoDB for Cart
- ECS Service Connect for private service-to-service communication
- One HTTPS Application Load Balancer with path-based routing
- GitHub Actions CI/CD using short-lived OIDC credentials
- Least-privilege IAM roles for deployment and runtime access
- CloudWatch logging, Container Insights, alarms, and AI-assisted triage
- ECS deployment circuit-breaker rollback
- Evidence collected from local, AWS, application, and failure-testing workflows

## The target architecture

The architecture was designed before implementation so that the delivery path, request path, internal service path, data ownership, and operational path were clear before resources were created.

**Evidence 01: Architecture diagram**

*Shows:* the target-state architecture before implementation.

**Why it matters:** Establishes the delivery path, internal service-to-service path, data ownership, CI/CD flow, and observability flow.

![ShopMesh target-state architecture](screenshots/01-architecture-diagram.png)

At runtime, users reach the HTTPS Application Load Balancer through `stiaan.click`. Requests for `/product/*` go to Catalog, while requests for `/cart/*` go to Cart. Cart does not call the ALB to retrieve product information. It calls `http://catalog:3000`, which resolves through ECS Service Connect inside the private VPC.

The operational path runs alongside the request path:

```text
CloudWatch alarm
      ↓
EventBridge
      ↓
Triage Lambda
      ↓
Amazon Bedrock
      ↓
SNS email notification
```

The application was deployed in `us-east-1` during testing. The evidence environment was destroyed after validation to avoid leaving billable AWS resources running. The CDK code can recreate it when needed.

## The story from local code to AWS

### 1. Start with two small services

The first implementation created two small Node.js and Express services. Catalog exposes `/health` and `/product/:id`. Cart exposes `/health`, `/cart/:id`, and `POST /cart/:id/items`. Cart calls Catalog by the service name rather than by an IP address, which creates the application seam later used by Service Connect.

**Evidence 02: Local container build and startup**

*Shows:* the two service images being built and started locally.

**Why it matters:** Proves the project can be run as a multi-container application before AWS is introduced.

![Local container build and startup](screenshots/02-build-start-containers.png)

The services were packaged with multi-stage Dockerfiles and run as the non-root `node` user. A root `compose.yaml` starts both containers together, allowing the Cart-to-Catalog request path to be tested before AWS is involved.

**Evidence 02.5: Local containers running**

*Shows:* the Catalog and Cart containers running locally.

**Why it matters:** Confirms both services are available together with the expected container ports.

![Local containers running](screenshots/02.5-local-containers-running.png)

**Evidence 03: Local add-to-cart flow**

*Shows:* Cart calling Catalog locally and returning a priced cart item.

**Why it matters:** Proves the service boundary works before Service Connect is configured in AWS.

![Local add-to-cart flow](screenshots/03-local-add-to-cart.png)

The local tests established a useful boundary: application behavior and container networking could be verified independently of cloud infrastructure.

---

### 2. Define the infrastructure before deploying it

The infrastructure was divided by responsibility rather than placed in one large stack:

- `NetworkStack`: VPC, subnets, ALB, HTTPS listener, and Service Connect namespace
- `CatalogStack`: Catalog ECR repository, ECS task and service, Aurora, and IAM roles
- `CartStack`: Cart ECR repository, ECS task and service, DynamoDB, and IAM roles
- `OpsStack`: logging, alarms, triage Lambda, SNS, and CI/CD OIDC roles

The dependency order is network, Catalog and Cart, then operations. CDK and CloudFormation derive the cross-stack deployment dependencies.

---

### 3. Build, scan, and deliver containers

GitHub Actions builds the changed service, pushes the image to its ECR repository, registers a new ECS task-definition revision, and updates only the affected service. Staging runs from pull requests. Production runs from pushes to `main`.

The workflows use GitHub's OIDC federation with AWS STS. No long-lived AWS access keys are stored in GitHub. Separate staging and production roles are scoped to the repositories, services, task definitions, and roles required by each workflow.

**Evidence 04: GitHub Actions workflows**

*Shows:* the staging, production, and reusable deployment workflows.

**Why it matters:** Makes the automated build, image push, and service deployment path visible.

![GitHub Actions workflows](screenshots/04-actions-workflows.png)

**Evidence 05: Staging deployment success**

*Shows:* a successful staging workflow run.

**Why it matters:** Proves pull-request changes can be validated in a separate deployment path.

![Staging deployment success](screenshots/05-staging-deploy-success.png)

**Evidence 06: Production deployment success**

*Shows:* a successful production workflow run.

**Why it matters:** Proves the tested service can be delivered to production through CI/CD.

![Production deployment success](screenshots/06-production-deploy-success.png)

**Evidence 07: Single-service redeployment**

*Shows:* one service being redeployed independently.

**Why it matters:** Demonstrates that microservices can be delivered without redeploying the whole application.

![Single-service redeployment](screenshots/07-single-service-redeploy.png)

**Evidence 08: Workflow files**

*Shows:* the workflow definitions stored in the repository.

**Why it matters:** Proves the delivery process is versioned as code rather than performed manually.

![Workflow files](screenshots/08-workflow-files.png)

**Evidence 09: Cart ECR repository**

*Shows:* the dedicated Cart container registry.

**Why it matters:** Confirms Cart has an independent image repository.

![Cart ECR repository](screenshots/09-ecr-cart-repository.png)

**Evidence 09.5: Catalog ECR repository**

*Shows:* the dedicated Catalog container registry.

**Why it matters:** Confirms Catalog has an independent image repository.

![Catalog ECR repository](screenshots/09.5-ecr-catalog-repository.png)

**Evidence 10: ECR image scanning**

*Shows:* vulnerability scanning configured for pushed images.

**Why it matters:** Adds an automated security check before an image is deployed.

![ECR image scanning](screenshots/10-ecr-image-scan.png)

---

### 4. Establish the AWS network and compute layer

The network uses public subnets for the internet-facing ALB and private subnets for ECS tasks and databases across multiple Availability Zones. Fargate was chosen instead of the EC2 launch type because the project does not need to manage operating systems, instance capacity, or patching.

**Evidence 11: VPC and subnets**

*Shows:* the public and private network layout.

**Why it matters:** Proves the ALB is separated from private ECS tasks and databases.

![VPC and subnets](screenshots/11-vpc-subnets.png)

**Evidence 12: ECS cluster**

*Shows:* the shared ECS cluster used by the services.

**Why it matters:** Confirms the services run on the Fargate orchestration layer.

![ECS cluster](screenshots/12-ecs-cluster.png)

Each service has its own ECS task definition, task role, execution role, security group, and deployment configuration. The Catalog and Cart services can therefore be changed and scaled independently.

**Evidence 13: Catalog ECS service**

*Shows:* the Catalog service configuration and running task.

**Why it matters:** Confirms Catalog is deployed and managed independently in ECS.

![Catalog ECS service](screenshots/13-ecs-catalog-service.png)

**Evidence 13.5: Cart ECS service**

*Shows:* the Cart service configuration and running task.

**Why it matters:** Confirms Cart is deployed and managed independently in ECS.

![Cart ECS service](screenshots/13.5-ecs-cart-service.png)

**Evidence 14: Service Connect**

*Shows:* the ECS Service Connect configuration.

**Why it matters:** Proves Cart and Catalog communicate privately by service name rather than through the public ALB.

![Service Connect configuration](screenshots/14-service-connect.png)

**Evidence 15: ECS task definition**

*Shows:* the service task-definition configuration.

**Why it matters:** Makes the container image, ports, roles, logging, and runtime settings visible.

![ECS task definition](screenshots/15-task-definition.png)

Service Connect provides private service discovery inside the VPC. Catalog is registered as `catalog`, and Cart uses `CATALOG_URL=http://catalog:3000`. A separate proxy ingress port prevents Service Connect from taking over the application port used by the ALB health check and target group.

---

### 5. Give each service ownership of its data

The data layer follows the service split. Catalog uses Aurora Serverless v2 PostgreSQL because it needs relational product data and a database that can scale capacity with demand. Cart uses DynamoDB because carts are naturally keyed by `cartId` and do not require relational joins.

Aurora credentials are generated and stored in Secrets Manager by CDK. ECS injects the secret into the Catalog task. Cart receives the DynamoDB table name through its task environment, and its task role is limited to its own table.

**Evidence 16: Aurora cluster**

*Shows:* the Aurora PostgreSQL data store for Catalog.

**Why it matters:** Confirms Catalog owns a relational database suited to product data.

![Aurora cluster](screenshots/16-aurora-cluster.png)

**Evidence 17: Secrets Manager**

*Shows:* the generated database credentials stored in Secrets Manager.

**Why it matters:** Proves database credentials are not hardcoded into the application or deployment workflow.

![Secrets Manager](screenshots/17-secrets-manager.png)

**Evidence 18: DynamoDB table**

*Shows:* the DynamoDB table used by Cart.

**Why it matters:** Confirms Cart owns a purpose-matched key-value data store.

![DynamoDB table](screenshots/18-dynamodb-table.png)

---

### 6. Put one secure HTTPS entry point in front

The ALB provides one public entry point for both services. ACM supplies the certificate for `stiaan.click`, Route 53 points the domain to the ALB, HTTP redirects to HTTPS, and listener rules route requests by path.

**Evidence 19: ALB listeners**

*Shows:* the HTTP and HTTPS listeners on the load balancer.

**Why it matters:** Proves the application has one public entry point with HTTPS enforcement.

![ALB listeners](screenshots/19-alb-listeners.png)

**Evidence 20: Target groups**

*Shows:* the Catalog and Cart target groups and health checks.

**Why it matters:** Confirms ALB traffic is routed to the correct service and only healthy tasks receive requests.

![Target groups](screenshots/20-target-groups.png)

**Evidence 21: ACM certificate**

*Shows:* the certificate used for the public domain.

**Why it matters:** Proves the public endpoint is configured for trusted HTTPS.

![ACM certificate](screenshots/21-acm-certificate.png)

**Evidence 22: Route 53 records**

*Shows:* the DNS records pointing the domain to the ALB.

**Why it matters:** Connects the public domain to the deployed application entry point.

![Route 53 records](screenshots/22-route53-records.png)

The target groups use `/health` checks so the ALB routes traffic only to healthy tasks. Catalog listens on port 3000 and Cart listens on port 3001.

---

### 7. Secure the delivery and runtime permissions

The runtime roles and deployment roles are intentionally separate. Catalog can read its database secret. Cart can access its own DynamoDB table. ECS execution roles can pull images and write logs. GitHub Actions deployment roles can push images, register task-definition revisions, update the correct ECS services, and pass only the service roles they need.

**Evidence 23: GitHub OIDC provider**

*Shows:* the GitHub OIDC identity provider in IAM.

**Why it matters:** Proves CI/CD can authenticate to AWS without stored long-lived credentials.

![GitHub OIDC provider](screenshots/23-iam-oidc-provider.png)

**Evidence 24: IAM roles**

*Shows:* the deployment and runtime IAM roles.

**Why it matters:** Makes the separation between deployment permissions and service permissions visible.

![IAM roles](screenshots/24-iam-roles.png)

**Evidence 25: IAM trust policy**

*Shows:* the restricted GitHub Actions trust policy.

**Why it matters:** Proves only the intended repository and workflow identities can assume the deployment role.

![IAM trust policy](screenshots/25-iam-trust-policy.png)

The deployment workflow required special handling for ECS task-definition metadata. The output of `describe-task-definition` contains response-only fields that cannot be passed directly to `register-task-definition`, so the workflow removes those fields before registering a new revision.

---

### 8. Add operational visibility

A healthy request path is not enough for a production system. Container Insights provides ECS-level visibility, while the Catalog and Cart containers write structured logs to separate CloudWatch log groups.

**Evidence 26: CloudWatch log groups**

*Shows:* the separate Catalog and Cart application log groups.

**Why it matters:** Provides the centralized service logs needed to trace requests and failures.

![CloudWatch log groups](screenshots/26-cloudwatch-log-groups.png)

**Evidence 27: Container Insights**

*Shows:* ECS metrics and service health through Container Insights.

**Why it matters:** Provides an operational view of task counts, resource use, and service health.

![Container Insights](screenshots/27-container-insights.png)

CloudWatch alarms cover ALB 5XX responses, unhealthy service tasks, and Cart-to-Catalog failures. The custom Cart-to-Catalog metric exists because infrastructure metrics alone cannot show every internal application failure.

**Evidence 28: CloudWatch alarms**

*Shows:* the configured failure alarms.

**Why it matters:** Proves the system has automated signals for ALB errors, unhealthy tasks, and internal service failures.

![CloudWatch alarms](screenshots/28-cloudwatch-alarms.png)

The operational response path uses EventBridge to invoke a triage Lambda when an alarm enters `ALARM`. The Lambda gathers recent context, asks Bedrock for a concise hypothesis, and publishes the result to SNS. The AI summary supports human investigation and does not perform automatic remediation.

**Evidence 29: SNS topic**

*Shows:* the SNS topic used for triage summaries.

**Why it matters:** Provides the notification destination for the human-readable incident summary.

![SNS topic](screenshots/29-sns-topic.png)

**Evidence 30: Triage Lambda**

*Shows:* the Lambda responsible for alarm triage.

**Why it matters:** Connects an alarm to log collection, Bedrock analysis, and SNS notification.

![Triage Lambda](screenshots/30-triage-lambda.png)

---

### 9. Validate the deployed request paths

After the infrastructure was stable, the real database-backed flows were tested through the public HTTPS endpoint. Catalog returned a product from Aurora, and Cart called Catalog through Service Connect before writing the priced item to DynamoDB.

**Evidence 31: Live product flow**

*Shows:* the deployed Catalog endpoint returning a product.

**Why it matters:** Proves the public HTTPS route reaches the live, database-backed Catalog service.

![Live product flow](screenshots/31-live-product-flow.png)

**Evidence 32: Live add-to-cart flow**

*Shows:* Cart returning a cart item priced by Catalog.

**Why it matters:** Proves the public Cart flow and the internal Catalog lookup work together.

![Live add-to-cart flow](screenshots/32-live-add-to-cart.png)

Structured service logs made the internal call visible. The Cart request, Catalog lookup, and Cart response were matched by timestamp. The Cart log explicitly showed `http://catalog:3000`, proving that the request used Service Connect rather than the ALB.

**Evidence 33: Cart-to-Catalog logs**

*Shows:* matching Cart and Catalog structured log events.

**Why it matters:** Proves Cart uses the internal `catalog` Service Connect name rather than routing through the ALB.

![Cart-to-Catalog logs](screenshots/33-cart-to-catalog-logs.png)

Each service also has its own target-tracking CPU policy. Catalog scales from 1 to 4 tasks, while Cart scales from 1 to 3 tasks.

**Evidence 34: Auto scaling**

*Shows:* the independent CPU target-tracking policies.

**Why it matters:** Proves Catalog and Cart can scale independently with different task-count ranges.

![Auto scaling policies](screenshots/34-auto-scaling.png)

The complete CDK deployment produced the four application stacks and their outputs.

**Evidence 35: CDK deployment output**

*Shows:* the four CDK stacks completing with their outputs.

**Why it matters:** Proves the deployed architecture is defined and reproducible through CDK.

![CDK deployment output](screenshots/35-cdk-deploy-output.png)

---

## Failure testing and recovery

The final test was designed to prove that the operational controls work, not only that the happy path works.

First, the Catalog database connection was temporarily misconfigured. The new task failed its ALB health check with HTTP 503, and the ECS deployment circuit breaker stopped the failed revision and rolled back to the previous healthy task definition.

**Evidence 36: Deliberate break**

*Shows:* the intentional Catalog database misconfiguration used for failure testing.

**Why it matters:** Documents the change that deliberately caused the ECS health-check failure.

![Deliberate failure change](screenshots/36-deliberate-break.png)

Next, a controlled Catalog HTTP 500 response was used to generate enough ALB 5XX traffic to cross the CloudWatch threshold. This produced the alarm state needed to test the operational chain.

**Evidence 37: CloudWatch alarm firing**

*Shows:* the relevant CloudWatch alarm in the firing state.

**Why it matters:** Proves the failure signal was detected by the monitoring system.

![CloudWatch alarm firing](screenshots/37-alarm-firing.png)

**Evidence 37.5: ALB 5XX alarm detail**

*Shows:* the ALB 5XX metric crossing its threshold.

**Why it matters:** Provides supplemental evidence that the generated HTTP failures produced the expected metric signal.

![ALB 5XX alarm firing](screenshots/37.5-alb-5xx-alarm-firing.png)

The alarm caused EventBridge to invoke the triage Lambda.

**Evidence 38: Triage Lambda invoked**

*Shows:* the triage Lambda invocation logs.

**Why it matters:** Proves EventBridge triggered the automated investigation step after the alarm fired.

![Triage Lambda invoked](screenshots/38-triage-lambda-invoked.png)

The resulting Bedrock-assisted summary was published through SNS to the confirmed email subscription.

**Evidence 39: AI summary delivered by SNS**

*Shows:* the Bedrock-assisted triage summary in the notification email.

**Why it matters:** Proves the alarm context reached a human as a concise explanation alongside the raw signal.

![AI triage summary email](screenshots/39-ai-summary-sns-email.png)

The ECS deployment event history showed the failed task, health-check failure, and rollback to the previous task definition.

**Evidence 40: ECS circuit-breaker rollback**

*Shows:* ECS rejecting the unhealthy deployment and rolling back.

**Why it matters:** Proves the deployment safety mechanism restored the previous healthy task definition.

![ECS circuit-breaker rollback](screenshots/40-circuit-breaker-rollback.png)

Finally, the Catalog database connection and product endpoint were restored. The product and cart flows returned successful responses and the system was healthy again.

**Evidence 41: System healthy after the fix**

*Shows:* the product and cart flows working after recovery.

**Why it matters:** Proves the broken configuration was removed and the system returned to a healthy state.

![System healthy after fix](screenshots/41-system-healthy-after-fix.png)

## Evidence summary

The evidence follows the same story as the implementation:

1. Build and run the two services locally.
2. Deliver them through GitHub Actions and ECR.
3. Create the AWS network, data, compute, security, and routing layers.
4. Add logs, alarms, triage, and email notification.
5. Prove the public product and cart flows.
6. Prove internal Service Connect communication.
7. Deliberately fail a deployment and verify ECS rollback.
8. Trigger an alarm and follow it through Lambda, Bedrock, and SNS.
9. Restore the system and verify healthy responses.

All collected screenshots are included above so the README can be read as a complete project record without requiring the reader to browse the repository first.

## What I would do at scale

This implementation is intentionally sized for a focused microservices project. A larger production platform could evolve in several directions:

- **Service mesh:** Use AWS App Mesh or another full service mesh if the service count grows beyond a handful and traffic policy, retries, and advanced telemetry become more important.
- **Deployment strategy:** Use CodeDeploy blue/green deployments for traffic shifting and zero-downtime releases when rolling deployments are no longer sufficient.
- **Edge protection:** Put AWS WAF in front of the ALB to provide managed protection against common web exploits and abusive traffic.
- **Observability:** Add distributed tracing, richer service-level objectives, dashboards, and longer-term log analytics.
- **Data evolution:** Add migrations, backups, restore testing, read scaling, and explicit data-retention policies as the Catalog and Cart datasets grow.
- **Platform separation:** Use separate AWS accounts or stronger environment isolation for development, staging, and production.
- **Delivery governance:** Add approvals, policy checks, dependency scanning, and progressive delivery controls for higher-risk changes.

## Development and infrastructure operations

Local container commands, CDK commands, stack responsibilities, deployment order, testing, and teardown instructions are documented in [`infrastructure/README.md`](infrastructure/README.md).
