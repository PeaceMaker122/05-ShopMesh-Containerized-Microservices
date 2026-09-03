import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

export interface CatalogStackProps extends cdk.StackProps {
  /** The shared VPC from the NetworkStack. */
  readonly vpc: ec2.Vpc;
}

export class CatalogStack extends cdk.Stack {
  /** ECR repository for Catalog container images. */
  public readonly repository: ecr.Repository;
  /** The Aurora Serverless v2 cluster backing the Catalog service. */
  public readonly cluster: rds.DatabaseCluster;

  constructor(scope: Construct, id: string, props: CatalogStackProps) {
    super(scope, id, props);

    const { vpc } = props;

    // Catalog's image registry. Image scanning on push checks for known
    // vulnerabilities the moment an image is uploaded, before it is deployed.
    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: 'shopmesh-catalog',
      imageScanOnPush: true,
    });

    // Aurora Serverless v2 (PostgreSQL) for the relational product data.
    // CDK generates and stores database credentials in Secrets Manager from
    // creation, so no password is ever set or hardcoded manually. The cluster
    // lives in the private subnets, unreachable from the internet.
    this.cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_11,
      }),
      vpc,
      writer: rds.ClusterInstance.serverlessV2('writer', {
        autoMinorVersionUpgrade: true,
      }),
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
  }
}