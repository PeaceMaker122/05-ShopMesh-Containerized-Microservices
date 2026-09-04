#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { CatalogStack } from '../lib/catalog-stack';
import { CartStack } from '../lib/cart-stack';
import { OpsStack } from '../lib/ops-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'us-east-1',
};

const network = new NetworkStack(app, 'NetworkStack', { env });

const catalog = new CatalogStack(app, 'CatalogStack', {
  env,
  vpc: network.vpc,
  cluster: network.cluster,
  serviceConnectNamespace: network.serviceConnectNamespace,
  httpsListener: network.httpsListener,
});

const cart = new CartStack(app, 'CartStack', {
  env,
  cluster: network.cluster,
  vpc: network.vpc,
  serviceConnectNamespace: network.serviceConnectNamespace,
  httpsListener: network.httpsListener,
});

new OpsStack(app, 'OpsStack', {
  env,
  catalogRepository: catalog.repository,
  catalogService: catalog.service,
  cartRepository: cart.repository,
  cartService: cart.service,
});