import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export interface NetworkStackProps extends cdk.StackProps {}

export class NetworkStack extends cdk.Stack {
  /** Public subnets used by the Application Load Balancer. */
  public readonly vpc: ec2.Vpc;
  /** The internet-facing ALB that path-routes /product and /cart. */
  public readonly alb: elbv2.ApplicationLoadBalancer;
  /** The ALB's HTTPS listener; services attach target groups to it. */
  public readonly httpsListener: elbv2.ApplicationListener;
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
    // and Cart (/cart) happens here via target groups attached by the service
    // stacks.
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: this.vpc,
      internetFacing: true,
    });

    // HTTP listener on port 80 redirects all traffic to HTTPS.
    this.alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        port: '443',
        protocol: 'HTTPS',
      }),
    });

    // Look up the Route 53 hosted zone for the owned domain. We reference the
    // hosted zone by attributes (deterministic, no live DNS lookup at synth)
    // using the real zone ID for stiaan.click.
    const hostedZone = route53.PublicHostedZone.fromPublicHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: 'Z0843183LFJZV57SYO4D',
      zoneName: 'stiaan.click',
    });

    // ACM certificate for the domain, DNS-validated through Route 53. Using a
    // real owned domain avoids the validation failure that a placeholder causes.
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: 'stiaan.click',
      subjectAlternativeNames: ['*.stiaan.click'],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // HTTPS listener requiring a default action to synthesize. Requests that
    // match no path rule (neither /product nor /cart) get a fixed 503; the
    // service stacks attach the real path rules here.
    this.httpsListener = this.alb.addListener('HttpsListener', {
      port: 443,
      certificates: [certificate],
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