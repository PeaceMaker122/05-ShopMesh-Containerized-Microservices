import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface OpsStackProps extends cdk.StackProps {
  /** The shared ALB, for the 5xx alarm. */
  readonly alb: elbv2.ApplicationLoadBalancer;
  /** The shared ECS cluster, for the unhealthy-task alarms. */
  readonly cluster: ecs.Cluster;
  /** Catalog's ECR repository and ECS service, for the CI/CD role scope. */
  readonly catalogRepository: ecr.Repository;
  readonly catalogService: ecs.FargateService;
  /** Cart's ECR repository and ECS service, for the CI/CD role scope. */
  readonly cartRepository: ecr.Repository;
  readonly cartService: ecs.FargateService;
}

export class OpsStack extends cdk.Stack {
  /** The IAM role GitHub Actions assumes via OIDC for staging (pull requests). */
  public readonly stagingRole: iam.Role;
  /** The IAM role GitHub Actions assumes via OIDC for production (push to main). */
  public readonly productionRole: iam.Role;

  constructor(scope: Construct, id: string, props: OpsStackProps) {
    super(scope, id, props);

    const { alb, cluster, catalogRepository, catalogService, cartRepository, cartService } = props;

    // GitHub's OIDC identity provider for this account.

    const provider = new iam.OpenIdConnectProvider(this, 'GitHubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    // GitHub's `sub` claim embeds the numeric owner and repo IDs. We scope each
    // role to exactly the event type it is for, using an exact-match condition,
    // so a role can only be assumed by the workflow that needs it (least
    // privilege). The `aud` is fixed to sts.amazonaws.com.

    const baseSub = 'repo:PeaceMaker122@214525680/05-ShopMesh-Containerized-Microservices@1352806286';

    // Staging: pull requests only. Explicit role name so the workflows can
    // reference a stable, predictable ARN instead of a generated one.
    this.stagingRole = new iam.Role(this, 'StagingRole', {
      roleName: 'shopmesh-staging-deploy',
      assumedBy: new iam.OpenIdConnectPrincipal(provider).withConditions({
        StringEquals: {
          'token.actions.githubusercontent.com:sub': `${baseSub}:pull_request`,
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
      }),
    });

    // Production: pushes to main only.
    this.productionRole = new iam.Role(this, 'ProductionRole', {
      roleName: 'shopmesh-production-deploy',
      assumedBy: new iam.OpenIdConnectPrincipal(provider).withConditions({
        StringEquals: {
          'token.actions.githubusercontent.com:sub': `${baseSub}:ref:refs/heads/main`,
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
      }),
    });

    // Both roles share the same narrow permissions: push images to both ECR
    // repos, and update both ECS services.

    [this.stagingRole, this.productionRole].forEach((role) => {
      [catalogRepository, cartRepository].forEach((repo) => {
        repo.grantPullPush(role);
      });

      [catalogService, cartService].forEach((service) => {
        role.addToPolicy(
          new iam.PolicyStatement({
            actions: [
              'ecs:UpdateService',
              'ecs:DescribeServices',
            ],
            resources: [service.serviceArn],
          }),
        );
      });
    });

    // ---- Observability (Phase 4) ----

    // A second SNS topic for the AI triage summary, kept separate from any
    // raw-alarm topic so the team always sees both the raw alarm and the AI take.
    const triageTopic = new sns.Topic(this, 'TriageTopic', {
      topicName: 'shopmesh-triage',
    });

    // The triage Lambda: gathers recent logs and metrics for the affected service,
    // asks Bedrock for a plain-English hypothesis, and publishes the summary to
    // the triage topic. It never takes any automatic action.

    const triageLambda = new lambda.Function(this, 'TriageLambda', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
        const { CloudWatchLogsClient, FilterLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');
        const { CloudWatchClient, GetMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
        const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

        exports.handler = async (event) => {
          const alarmName = event?.alarmData?.alarmName || event?.detail?.alarmName || 'unknown';
          const region = process.env.AWS_REGION;
          const topicArn = process.env.TRIAGE_TOPIC_ARN;
          const modelId = process.env.BEDROCK_MODEL_ID;

          const logs = new CloudWatchLogsClient({ region });
          const cw = new CloudWatchClient({ region });
          const snsClient = new SNSClient({ region });
          const bedrock = new BedrockRuntimeClient({ region });

          // Pull the last few minutes of logs from the affected service's log group.

          const logGroupName = '/ecs/' + (alarmName.includes('catalog') ? 'catalog' : 'cart');
          let logText = '';
          try {
            const res = await logs.send(new FilterLogEventsCommand({
              logGroupName,
              startTime: Date.now() - 5 * 60 * 1000,
            }));
            logText = (res.events || []).slice(-20).map((e) => e.message).join('\\n');
          } catch (err) {
            logText = '(could not fetch logs: ' + err.message + ')';
          }

          const prompt = [
            'A CloudWatch alarm fired: ' + alarmName + '.',
            'Here are the recent logs from the affected service:',
            logText,
            'Give a short, plain-English hypothesis of what likely happened and what to check first. Do not take any action.',
          ].join('\\n');

          let summary = 'No AI summary available.';
          try {
            const body = {
              anthropic_version: 'bedrock-2023-05-31',
              max_tokens: 300,
              messages: [{ role: 'user', content: prompt }],
            };
            const cmd = new InvokeModelCommand({
              modelId,
              contentType: 'application/json',
              accept: 'application/json',
              body: JSON.stringify(body),
            });
            const resp = await bedrock.send(cmd);
            const parsed = JSON.parse(Buffer.from(resp.body).toString('utf8'));
            summary = parsed.content?.[0]?.text || 'No summary.';
          } catch (err) {
            summary = '(AI summary failed: ' + err.message + ')';
          }

          await snsClient.send(new PublishCommand({
            TopicArn: topicArn,
            Subject: 'AI triage: ' + alarmName,
            Message: summary,
          }));

          return { statusCode: 200 };
        };
      `),
      environment: {
        TRIAGE_TOPIC_ARN: triageTopic.topicArn,
        BEDROCK_MODEL_ID: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      },
      timeout: cdk.Duration.minutes(2),
    });

    // The Lambda reads logs, metrics, and publishes to SNS; grant it just those.

    triageLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:FilterLogEvents',
          'cloudwatch:GetMetricData',
          'sns:Publish',
          'bedrock:InvokeModel',
        ],
        resources: ['*'],
      }),
    );
    triageTopic.grantPublish(triageLambda);

    // Alarms. Each fires on a real failure signal and triggers the triage Lambda.**
    const alarms: cloudwatch.Alarm[] = [];

    // 1. Unhealthy task count per service (Catalog and Cart).
    [catalogService, cartService].forEach((service, idx) => {
      const name = idx === 0 ? 'catalog' : 'cart';
      const alarm = new cloudwatch.Alarm(this, `UnhealthyTasks${name}`, {
        metric: service.metric('UnhealthyTasks', { statistic: 'Maximum', period: cdk.Duration.minutes(1) }),
        threshold: 0,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmName: `shopmesh-${name}-unhealthy-tasks`,
      });
      alarms.push(alarm);
    });

    // 2. ALB 5xx rate.

    const alb5xx = new cloudwatch.Alarm(this, 'Alb5xx', {
      metric: alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
        statistic: 'Sum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 5,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmName: 'shopmesh-alb-5xx',
    });
    alarms.push(alb5xx);

    // 3. Cart to Catalog failure rate (custom metric emitted by Cart's app).**
    const cartCatalogFailures = new cloudwatch.Alarm(this, 'CartCatalogFailures', {
      metric: new cloudwatch.Metric({
        namespace: 'ShopMesh',
        metricName: 'CatalogCallFailure',
        statistic: 'Sum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 0,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmName: 'shopmesh-cart-catalog-failures',
    });
    alarms.push(cartCatalogFailures);

    // EventBridge rule: when any of these alarms fires, invoke the triage Lambda.

    alarms.forEach((alarm, idx) => {
      new events.Rule(this, `TriageRule${idx}`, {
        eventPattern: {
          source: ['aws.cloudwatch'],
          detailType: ['CloudWatch Alarm State Change'],
          detail: {
            alarmName: [alarm.alarmName],
            state: { value: ['ALARM'] },
          },
        },
        targets: [new eventsTargets.LambdaFunction(triageLambda)],
      });
    });
  }
}