import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface CatalogStackProps extends cdk.StackProps {}

export class CatalogStack extends cdk.Stack {
  /** ECR repository for Catalog container images. */
  public readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: CatalogStackProps = {}) {
    super(scope, id, props);

    // Catalog's image registry. Image scanning on push checks for known
    // vulnerabilities the moment an image is uploaded, before it is deployed.
    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: 'shopmesh-catalog',
      imageScanOnPush: true,
    });
  }
}