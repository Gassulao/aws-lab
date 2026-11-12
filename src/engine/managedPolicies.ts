// Políticas gestionadas por AWS que usan los laboratorios (documentos reales simplificados).
import type { IamPolicy, PolicyDocument } from './types';
import { CONTAINER_POLICIES } from './containerPolicies';
import { SERVERLESS_POLICIES } from './serverlessPolicies';

function p(name: string, doc: PolicyDocument, description: string, path = '/'): Omit<IamPolicy, 'attachmentCount' | 'createdAt' | 'id'> {
  return { arn: `arn:aws:iam::aws:policy${path}${name}`, name, path, managed: 'aws', defaultVersion: 'v1', document: doc, description };
}

const allow = (action: string | string[], resource: string | string[] = '*') => ({ Effect: 'Allow' as const, Action: action, Resource: resource });

export const AWS_MANAGED: Omit<IamPolicy, 'attachmentCount' | 'createdAt' | 'id'>[] = [
  p('AdministratorAccess', { Version: '2012-10-17', Statement: [allow('*')] }, 'Provides full access to AWS services and resources.'),
  p('PowerUserAccess', { Version: '2012-10-17', Statement: [{ Effect: 'Allow', NotAction: ['iam:*', 'organizations:*', 'account:*'], Resource: '*' }] }, 'Provides full access to AWS services and resources, but does not allow management of Users and groups.'),
  p('ReadOnlyAccess', { Version: '2012-10-17', Statement: [allow(['s3:Get*', 's3:List*', 'ec2:Describe*', 'iam:Get*', 'iam:List*', 'cloudtrail:LookupEvents', 'cloudwatch:Get*', 'cloudwatch:List*', 'cloudwatch:Describe*', 'ssm:Describe*', 'ssm:Get*', 'ssm:List*'])] }, 'Provides read-only access to AWS services and resources.'),
  p('AmazonS3FullAccess', { Version: '2012-10-17', Statement: [allow(['s3:*', 's3-object-lambda:*'])] }, 'Provides full access to all buckets via the AWS Management Console.'),
  p('AmazonS3ReadOnlyAccess', { Version: '2012-10-17', Statement: [allow(['s3:Get*', 's3:List*', 's3-object-lambda:Get*', 's3-object-lambda:List*'])] }, 'Provides read only access to all buckets via the AWS Management Console.'),
  p('AmazonEC2FullAccess', { Version: '2012-10-17', Statement: [allow(['ec2:*', 'elasticloadbalancing:*', 'cloudwatch:*', 'autoscaling:*'])] }, 'Provides full access to Amazon EC2 via the AWS Management Console.'),
  p('AmazonEC2ReadOnlyAccess', { Version: '2012-10-17', Statement: [allow(['ec2:Describe*', 'elasticloadbalancing:Describe*', 'cloudwatch:ListMetrics', 'cloudwatch:GetMetricStatistics', 'cloudwatch:Describe*', 'autoscaling:Describe*'])] }, 'Provides read only access to Amazon EC2 via the AWS Management Console.'),
  p('AmazonVPCFullAccess', { Version: '2012-10-17', Statement: [allow(['ec2:*Vpc*', 'ec2:*Subnet*', 'ec2:*Gateway*', 'ec2:*Route*', 'ec2:*Address*', 'ec2:*SecurityGroup*', 'ec2:*NetworkAcl*', 'ec2:Describe*', 'ec2:CreateTags', 'ec2:DeleteTags'])] }, 'Provides full access to Amazon VPC via the AWS Management Console.'),
  p('AmazonSSMManagedInstanceCore', { Version: '2012-10-17', Statement: [allow(['ssm:UpdateInstanceInformation', 'ssm:ListAssociations', 'ssm:GetDocument', 'ssm:DescribeDocument', 'ssmmessages:*', 'ec2messages:*'])] }, 'The policy for Amazon EC2 Role to enable AWS Systems Manager service core functionality.', '/'),
  p('IAMReadOnlyAccess', { Version: '2012-10-17', Statement: [allow(['iam:Get*', 'iam:List*', 'iam:Generate*', 'iam:Simulate*'])] }, 'Provides read only access to IAM via the AWS Management Console.'),
  p('IAMFullAccess', { Version: '2012-10-17', Statement: [allow(['iam:*', 'organizations:DescribeAccount', 'organizations:DescribeOrganization'])] }, 'Provides full access to IAM via the AWS Management Console.'),
  p('AWSCloudTrail_ReadOnlyAccess', { Version: '2012-10-17', Statement: [allow(['cloudtrail:Get*', 'cloudtrail:Describe*', 'cloudtrail:List*', 'cloudtrail:LookupEvents'])] }, 'Provides read only access to AWS CloudTrail.'),
  p('AmazonSSMReadOnlyAccess', { Version: '2012-10-17', Statement: [allow(['ssm:Describe*', 'ssm:Get*', 'ssm:List*'])] }, 'Provides read only access to Amazon SSM.'),
];

// Contenedores (ECR, ECS, EKS).
AWS_MANAGED.push(...CONTAINER_POLICIES);
// Sin servidor y datos (Lambda, API Gateway, SQS, SNS, DynamoDB, RDS).
AWS_MANAGED.push(...SERVERLESS_POLICIES);
