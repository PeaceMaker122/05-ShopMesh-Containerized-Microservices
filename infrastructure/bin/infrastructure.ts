#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { CatalogStack } from '../lib/catalog-stack';
import { CartStack } from '../lib/cart-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'us-east-1',
};

const network = new NetworkStack(app, 'NetworkStack', { env });

new CatalogStack(app, 'CatalogStack', {
  env,
  vpc: network.vpc,
  cluster: network.cluster,
});

new CartStack(app, 'CartStack', {
  env,
  cluster: network.cluster,
});