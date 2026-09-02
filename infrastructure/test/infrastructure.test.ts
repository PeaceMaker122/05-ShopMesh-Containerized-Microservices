import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';

test('Network stack creates a VPC and an internet-facing ALB', () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'TestNetworkStack');
  const template = Template.fromStack(stack);

  // A VPC with at least one private and one public subnet should exist.
  template.resourceCountIs('AWS::EC2::VPC', 1);
  template.hasResource('AWS::EC2::Subnet', {});

  // An internet-facing Application Load Balancer should exist.
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internet-facing',
  });
});