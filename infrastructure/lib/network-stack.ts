import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export interface NetworkStackProps extends cdk.StackProps {}

export class NetworkStack extends cdk.Stack {
  /** Public subnets used by the Application Load Balancer. */
  public readonly vpc: ec2.Vpc;
  /** The internet-facing ALB that path-routes /product and /cart. */
  public readonly alb: elbv2.ApplicationLoadBalancer;
  /** The ALB's HTTP listener; services attach target groups to it. */
  public readonly httpListener: elbv2.ApplicationListener;
  /** The shared ECS cluster that hosts both services, running on Fargate. */
  public readonly cluster: ecs.Cluster;
  /** The Cloud Map namespace used by ECS Service Connect for service discovery. */
  public readonly serviceConnectNamespace: servicediscovery.IPrivateDnsNamespace;

  constructor(scope: Construct, id: string, props: NetworkStackProps = {}) {
    super(scope, id, props);

    // VPC with public subnets for the ALB and private subnets for the ECS
    // tasks and both databases, across at least two AZs for resilience.
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    // The single public entry point. Path-based routing to Catalog (/product)
    // and Cart (/cart) happens on the listener via target groups attached by
    // the service stacks (or here once target groups exist).
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: this.vpc,
      internetFacing: true,
    });

    // Listener requiring at least one default action to synthesize. Requests
    // that match no path rule (i.e. neither /product nor /cart) get a fixed
    // 503 from the load balancer; service stacks attach the real rules later.
    this.httpListener = this.alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.fixedResponse(503, {
        contentType: 'text/plain',
        messageBody: 'no matching service',
      }),
    });

    // The shared ECS cluster hosting both services on Fargate (no EC2
    // instances to manage).
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: this.vpc,
    });

    // The Cloud Map namespace behind ECS Service Connect. Services register
    // under a short name here, so Cart can reach Catalog at http://catalog:3000
    // instead of a hardcoded IP.
    this.serviceConnectNamespace = new servicediscovery.PrivateDnsNamespace(this, 'ServiceConnectNamespace', {
      name: 'shopmesh.local',
      vpc: this.vpc,
    });
  }
}