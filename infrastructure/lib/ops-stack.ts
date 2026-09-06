import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface OpsStackProps extends cdk.StackProps {
  /** Catalog's ECR repository and ECS service, for the CI/CD role scope. */
  readonly catalogRepository: ecr.Repository;
  readonly catalogService: ecs.IFargateService;
  /** Cart's ECR repository and ECS service, for the CI/CD role scope. */
  readonly cartRepository: ecr.Repository;
  readonly cartService: ecs.IFargateService;
}

export class OpsStack extends cdk.Stack {
  /** The IAM role GitHub Actions assumes via OIDC for staging (pull requests). */
  public readonly stagingRole: iam.Role;
  /** The IAM role GitHub Actions assumes via OIDC for production (push to main). */
  public readonly productionRole: iam.Role;

  constructor(scope: Construct, id: string, props: OpsStackProps) {
    super(scope, id, props);

    const { catalogRepository, catalogService, cartRepository, cartService } = props;

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

    // Staging: pull requests only.
    this.stagingRole = new iam.Role(this, 'StagingRole', {
      assumedBy: new iam.OpenIdConnectPrincipal(provider).withConditions({
        StringEquals: {
          'token.actions.githubusercontent.com:sub': `${baseSub}:pull_request`,
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
      }),
    });

    // Production: pushes to main only.
    this.productionRole = new iam.Role(this, 'ProductionRole', {
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
  }
}