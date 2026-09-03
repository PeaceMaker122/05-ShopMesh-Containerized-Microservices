import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface CartStackProps extends cdk.StackProps {}

export class CartStack extends cdk.Stack {
  /** ECR repository for Cart container images. */
  public readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: CartStackProps = {}) {
    super(scope, id, props);

    // Cart's image registry. Image scanning on push checks for known
    // vulnerabilities the moment an image is uploaded, before it is deployed.
    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: 'shopmesh-cart',
      imageScanOnPush: true,
    });
  }
}