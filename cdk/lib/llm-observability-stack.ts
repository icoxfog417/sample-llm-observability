import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Function, Runtime, AssetCode, Tracing, LayerVersion, FunctionUrlAuthType, HttpMethod, Version as LambdaVersion } from 'aws-cdk-lib/aws-lambda';
import { Table, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import { Guardrail, ContentFilterType, ContentFilterStrength } from '@cdklabs/generative-ai-cdk-constructs/lib/cdk-lib/bedrock';
import { S3BucketOrigin, FunctionUrlOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Bucket, BlockPublicAccess } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source} from 'aws-cdk-lib/aws-s3-deployment';
import { Role, Effect, ServicePrincipal, ManagedPolicy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Distribution, ViewerProtocolPolicy, AllowedMethods, CfnOriginAccessControl, CfnDistribution, LambdaEdgeEventType } from 'aws-cdk-lib/aws-cloudfront';
import path = require('path');

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
    const guardrailVersion = 'DRAFT';

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
      effect: Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:ApplyGuardrail'
      ],
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        'arn:aws:bedrock:*:*:inference-profile/*',
        'arn:aws:bedrock:*:*:application-inference-profile/*',
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
    
    // Create Endpoint by Function URL with restricted access
    const functionUrl = chatFunction.addFunctionUrl({
      authType: FunctionUrlAuthType.AWS_IAM, // Use IAM authentication for better security
      cors: {
        allowedOrigins: ['*'], // We'll set this to a more restrictive value in production
        allowedMethods: [HttpMethod.ALL],
        allowedHeaders: ['Content-Type', 'X-Identity-Role-Arn', 'X-Amz-Content-Sha256'],
      },
    });
    
    // Create the edge auth function for CloudFront using Lambda@Edge
    const edgeAuthFunction = new Function(this, 'EdgeAuthFunction', {
      runtime: Runtime.NODEJS_18_X, 
      code: new AssetCode(backendPath),
      handler: 'edge-auth.handler',
      role: new Role(this, 'EdgeAuthFunctionRole', {
        assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
        ]
      })
    });
    
    // Add edge lambda permission
    edgeAuthFunction.addPermission('AllowEdgeLambda', {
      principal: new ServicePrincipal('edgelambda.amazonaws.com'),
      action: 'lambda:InvokeFunction'
    });
    
    // Create a version for the Lambda@Edge function (required for Lambda@Edge)
    const edgeAuthVersion = new LambdaVersion(this, 'EdgeAuthVersion', {
      lambda: edgeAuthFunction,
      removalPolicy: RemovalPolicy.DESTROY, // RETAIN is preferable in production to preserve existing function at all edge locations.
    });
    
    // Create Origin Access Control for Lambda Function URLs
    const apiOriginAccessControl = new CfnOriginAccessControl(this, 'OriginAccessControl', {
      originAccessControlConfig: {
        name: "OriginAccessControlLambda",
        originAccessControlOriginType: "lambda",
        signingBehavior: "always",
        signingProtocol: "sigv4",
        description: "Origin Access Control for Lambda Function URL"
      },
    });

    // Create CloudFront distribution with function association
    const distribution = new Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(websiteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD
      },
      additionalBehaviors: {
        '/api/*': {
          origin: FunctionUrlOrigin.withOriginAccessControl(functionUrl),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          edgeLambdas: [{
            functionVersion: edgeAuthVersion,
            eventType: LambdaEdgeEventType.VIEWER_REQUEST,
            includeBody: true
          }]
        }
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
    
    // Access the L1 CloudFront Distribution construct to set the Origin Access Control ID
    // We assume Origin.1 is API origin setting.
    const cfnDistribution = distribution.node.defaultChild as CfnDistribution;
    cfnDistribution.addPropertyOverride('DistributionConfig.Origins.1.OriginAccessControlId', apiOriginAccessControl.attrId);
    
    // Grant the CloudFront identity permission to invoke the Lambda function URL
    chatFunction.addPermission('InvokePermission', {
      principal: new ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunctionUrl',
      sourceArn: `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`
    });

    // Deploy frontend to S3
    new BucketDeployment(this, 'DeployWebsite', {
      sources: [
        Source.asset(frontendBuildPath)
      ],
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
