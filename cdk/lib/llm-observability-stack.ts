import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Function, Runtime, AssetCode, Tracing, LayerVersion, FunctionUrlAuthType, HttpMethod } from 'aws-cdk-lib/aws-lambda';
import { Table, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import { Guardrail, ContentFilterType, ContentFilterStrength } from '@cdklabs/generative-ai-cdk-constructs/lib/cdk-lib/bedrock';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Bucket, BlockPublicAccess } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source} from 'aws-cdk-lib/aws-s3-deployment';
import path from 'path';
import { Role, ServicePrincipal, ManagedPolicy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Distribution, ViewerProtocolPolicy, AllowedMethods } from 'aws-cdk-lib/aws-cloudfront';

export class LlmObservabilityStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Define source paths
    const sourceRoot = path.join(__dirname, '../../src');
    const backendPath = path.join(sourceRoot, 'backend/dist');
    const frontendBuildPath = path.join(sourceRoot, 'frontend/build');

    // Create DynamoDB table
    const chatTable = new Table(this, 'ChatTable', {
      partitionKey: { name: 'id', type: AttributeType.STRING },
      sortKey: { name: 'timestamp', type: AttributeType.NUMBER },
      timeToLiveAttribute: 'ttl',
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY, // For demo purposes only
    });

    // Create Bedrock Guardrails
    const guardrails = new Guardrail(this, 'ChatGuardrails', {
      name: 'llm-observability-guardrails',
      description: 'Guardrails for LLM observability demo',
    });

    // Add content filters
    guardrails.addContentFilter({
      type: ContentFilterType.HATE,
      inputStrength: ContentFilterStrength.LOW,
      outputStrength: ContentFilterStrength.LOW,
    });
    
    guardrails.addContentFilter({
      type: ContentFilterType.SEXUAL,
      inputStrength: ContentFilterStrength.LOW,
      outputStrength: ContentFilterStrength.LOW,
    });
    
    guardrails.addContentFilter({
      type: ContentFilterType.VIOLENCE,
      inputStrength: ContentFilterStrength.LOW,
      outputStrength: ContentFilterStrength.LOW,
    });

    // Create a version for deployment - we'll use DRAFT to always get the latest version
    const guardrailVersion = 'LATEST';

    // Create a Lambda Layer with AWS Distro for OpenTelemetry Lambda
    // https://aws-otel.github.io/docs/getting-started/lambda/lambda-js
    const powertoolsLayer = LayerVersion.fromLayerVersionArn(
      this,
      'ADOTJSLayer',
      `arn:aws:lambda:${Stack.of(this).region}:901920570463:layer:aws-otel-nodejs-amd64-ver-1-30-1:2`
    );

    // Create Lambda function
    const chatFunction = new Function(this, 'ChatFunction', {
      runtime: Runtime.NODEJS_22_X,
      code: new AssetCode(backendPath),
      handler: 'index.handler',
      timeout: Duration.minutes(5), // Extended for streaming responses
      tracing: Tracing.ACTIVE, // Enable tracing
      environment: {
        TABLE_NAME: chatTable.tableName,
        GUARDRAIL_ID: guardrails.guardrailId,
        GUARDRAIL_VERSION: guardrailVersion,
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-handler'
      }, // Thanks to AWS_LAMBDA_EXEC_WRAPPER, Lambda execution is traced by otel-hander.
      layers: [powertoolsLayer]
    });

    // Add required permissions for Application Signals
    chatFunction.role?.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLambdaApplicationSignalsExecutionRolePolicy')
    );

    // Grant Lambda permissions to access DynamoDB
    chatTable.grantReadWriteData(chatFunction);

    // Grant Lambda permissions to access all Amazon Bedrock models
    chatFunction.addToRolePolicy(new PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:ApplyGuardrail'
      ],
      resources: [
        `arn:aws:bedrock:${Stack.of(this).region}::foundation-model/*`,
        guardrails.guardrailArn
      ],
    }));
    
    // Create S3 bucket for frontend hosting
    const websiteBucket = new Bucket(this, 'WebsiteBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'index.html',
      publicReadAccess: false,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    });

    // Create CloudFront distribution
    const distribution = new Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(websiteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
    });
    
    // Create an identity for the CloudFront distribution to use when calling the Lambda function
    const identityPool = new Role(this, 'CloudFrontIdentity', {
      assumedBy: new ServicePrincipal('cloudfront.amazonaws.com', {
        conditions: {
          StringEquals: {
            'AWS:SourceArn': `arn:aws:cloudfront::${Stack.of(this).account}:distribution/${distribution.distributionId}`
          }
        }
      }),
    });
    
    // Grant the CloudFront identity permission to invoke the Lambda function URL
    identityPool.addToPolicy(new PolicyStatement({
      actions: ['lambda:InvokeFunctionUrl'],
      resources: [chatFunction.functionArn],
      conditions: {
        StringEquals: {
          'lambda:FunctionUrlAuthType': 'AWS_IAM'
        }
      }
    }));
    
    // Create Endpoint by Function URL with restricted access
    const functionUrl = chatFunction.addFunctionUrl({
      authType: FunctionUrlAuthType.AWS_IAM, // Use IAM authentication for better security
      cors: {
        allowedOrigins: [`https://${distribution.distributionDomainName}`], // Only allow the CloudFront domain
        allowedMethods: [HttpMethod.ALL],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
      },
    });

    // Deploy frontend to S3
    new BucketDeployment(this, 'DeployWebsite', {
      sources: [Source.asset(frontendBuildPath)],
      destinationBucket: websiteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // Output the Function URL and CloudFront URL for easy access
    new CfnOutput(this, 'ChatFunctionUrl', {
      value: functionUrl.url,
      description: 'URL for the chat Lambda function',
    });

    new CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'URL for the frontend application',
    });
  }
}