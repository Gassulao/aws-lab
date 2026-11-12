// Políticas gestionadas de AWS para Lambda, API Gateway, SQS, DynamoDB, RDS y SNS (documentos reales simplificados).
import type { IamPolicy, PolicyDocument } from './types';

const mp = (name: string, doc: PolicyDocument, description: string, path = '/'): Omit<IamPolicy, 'attachmentCount' | 'createdAt' | 'id'> => ({ arn: `arn:aws:iam::aws:policy${path}${name}`, name, path, managed: 'aws', defaultVersion: 'v1', document: doc, description });
const allow = (action: string[], resource: string | string[] = '*') => ({ Effect: 'Allow' as const, Action: action, Resource: resource });
const doc = (...st: ReturnType<typeof allow>[]): PolicyDocument => ({ Version: '2012-10-17', Statement: st });

export const SERVERLESS_POLICIES = [
  mp('AWSLambdaBasicExecutionRole', doc(allow(['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'])), 'Provides write permissions to CloudWatch Logs.', '/service-role/'),
  mp('AWSLambdaSQSQueueExecutionRole', doc(allow(['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'])), 'Provides receive message, delete message, and read attribute access to SQS queues, and write permissions to CloudWatch logs.', '/service-role/'),
  mp('AWSLambdaVPCAccessExecutionRole', doc(allow(['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'ec2:CreateNetworkInterface', 'ec2:DescribeNetworkInterfaces', 'ec2:DeleteNetworkInterface', 'ec2:AssignPrivateIpAddresses', 'ec2:UnassignPrivateIpAddresses'])), 'Provides minimum permissions for a Lambda function to execute while accessing a resource within a VPC.', '/service-role/'),
  mp('AWSLambda_FullAccess', doc(allow(['lambda:*', 'logs:*', 'iam:ListRoles', 'iam:PassRole', 'sqs:ListQueues', 'sns:ListTopics', 'cloudwatch:GetMetricData', 'cloudwatch:ListMetrics'])), 'Grants full access to AWS Lambda service, AWS Lambda console features, and other related AWS services.'),
  mp('AWSLambda_ReadOnlyAccess', doc(allow(['lambda:Get*', 'lambda:List*', 'logs:Describe*', 'logs:Get*', 'logs:FilterLogEvents', 'cloudwatch:GetMetricData', 'cloudwatch:ListMetrics'])), 'Grants read-only access to AWS Lambda service, AWS Lambda console features, and other related AWS services.'),
  mp('AWSLambdaRole', doc(allow(['lambda:InvokeFunction'])), 'Default policy for AWS Lambda service role.', '/service-role/'),
  mp('AmazonSQSFullAccess', doc(allow(['sqs:*'])), 'Provides full access to Amazon SQS via the AWS Management Console.'),
  mp('AmazonSQSReadOnlyAccess', doc(allow(['sqs:GetQueueAttributes', 'sqs:GetQueueUrl', 'sqs:ListQueues', 'sqs:ListDeadLetterSourceQueues', 'sqs:ListQueueTags'])), 'Provides read only access to Amazon SQS queues via the AWS Management Console.'),
  mp('AmazonSNSFullAccess', doc(allow(['sns:*'])), 'Provides full access to Amazon SNS via the AWS Management Console.'),
  mp('AmazonSNSReadOnlyAccess', doc(allow(['sns:GetTopicAttributes', 'sns:List*'])), 'Provides read only access to Amazon SNS via the AWS Management Console.'),
  mp('AmazonDynamoDBFullAccess', doc(allow(['dynamodb:*', 'cloudwatch:*', 'application-autoscaling:*', 'iam:PassRole'])), 'Provides full access to Amazon DynamoDB via the AWS Management Console.'),
  mp('AmazonDynamoDBReadOnlyAccess', doc(allow(['dynamodb:BatchGetItem', 'dynamodb:Describe*', 'dynamodb:GetItem', 'dynamodb:ListTables', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:ListTagsOfResource', 'cloudwatch:GetMetricData'])), 'Provides read only access to Amazon DynamoDB via the AWS Management Console.'),
  mp('AmazonRDSFullAccess', doc(allow(['rds:*', 'ec2:Describe*', 'kms:DescribeKey', 'kms:ListAliases', 'cloudwatch:GetMetricStatistics', 'logs:DescribeLogStreams', 'logs:GetLogEvents'])), 'Provides full access to Amazon RDS via the AWS Management Console.'),
  mp('AmazonRDSReadOnlyAccess', doc(allow(['rds:Describe*', 'rds:ListTagsForResource', 'ec2:DescribeAccountAttributes', 'ec2:DescribeAvailabilityZones', 'ec2:DescribeInternetGateways', 'ec2:DescribeSecurityGroups', 'ec2:DescribeSubnets', 'ec2:DescribeVpcAttribute', 'ec2:DescribeVpcs', 'cloudwatch:GetMetricStatistics'])), 'Provides read only access to Amazon RDS via the AWS Management Console.'),
  mp('AmazonAPIGatewayAdministrator', doc(allow(['apigateway:*'])), 'Provides full access to create/edit/delete APIs in Amazon API Gateway via the AWS Management Console.'),
  mp('AmazonAPIGatewayInvokeFullAccess', doc(allow(['execute-api:Invoke', 'execute-api:ManageConnections'])), 'Provides full access to invoke APIs in Amazon API Gateway.'),
];
