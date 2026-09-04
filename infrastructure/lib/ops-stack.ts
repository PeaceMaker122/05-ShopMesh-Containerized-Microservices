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
  /** The IAM role GitHub Actions assumes via OIDC to push images and deploy. */
  public readonly githubActionsRole: iam.Role;

  constructor(scope: Construct, id: string, props: OpsStackProps) {
    super(scope, id, props);

    const { catalogRepository, catalogService, cartRepository, cartService } = props;

    // GitHub's OIDC identity provider for this account.
    const provider = new iam.OpenIdConnectProvider(this, 'GitHubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    // The role GitHub Actions assumes. Trust is scoped to this repo via an
    // exact-match `sub` condition. GitHub's `sub` embeds the numeric owner and
    // repo IDs, so this targets the real ShopMesh repo precisely rather than
    // relying on the older simple repo:owner/repo format.
    this.githubActionsRole = new iam.Role(this, 'GithubActionsRole', {
      assumedBy: new iam.OpenIdConnectPrincipal(provider).withConditions({
        StringLike: {
          'token.actions.githubusercontent.com:sub':
            'repo:PeaceMaker122@214525680/05-ShopMesh-Containerized-Microservices@1352806286:ref:refs/heads/*',
        },
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
      }),
    });

    // Permissions: push images to both ECR repos, and update both ECS services.
    [catalogRepository, cartRepository].forEach((repo) => {
      repo.grantPullPush(this.githubActionsRole);
    });

    [catalogService, cartService].forEach((service) => {
      this.githubActionsRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            'ecs:UpdateService',
            'ecs:DescribeServices',
          ],
          resources: [service.serviceArn],
        }),
      );
    });
  }
}