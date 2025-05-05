"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LlmObservabilityStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const bedrock = __importStar(require("@cdklabs/generative-ai-cdk-constructs/lib/cdk-lib/bedrock"));
const path = __importStar(require("path"));
const aws_cdk_lib_1 = require("aws-cdk-lib");
const aws_lambda_1 = require("aws-cdk-lib/aws-lambda");
const cloudfront = __importStar(require("aws-cdk-lib/aws-cloudfront"));
const origins = __importStar(require("aws-cdk-lib/aws-cloudfront-origins"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const s3deploy = __importStar(require("aws-cdk-lib/aws-s3-deployment"));
class LlmObservabilityStack extends cdk.Stack {
    constructor(scope, id, props) {
        var _a;
        super(scope, id, props);
        // Create DynamoDB table
        const chatTable = new dynamodb.Table(this, 'ChatTable', {
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
            timeToLiveAttribute: 'ttl',
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY, // For demo purposes only
        });
        // Create Bedrock Guardrails
        const guardrails = new bedrock.Guardrail(this, 'ChatGuardrails', {
            name: 'llm-observability-guardrails',
            description: 'Guardrails for LLM observability demo',
        });
        // Add content filters
        guardrails.addContentFilter({
            type: bedrock.ContentFilterType.HATE,
            inputStrength: bedrock.ContentFilterStrength.LOW,
            outputStrength: bedrock.ContentFilterStrength.LOW,
        });
        guardrails.addContentFilter({
            type: bedrock.ContentFilterType.SEXUAL,
            inputStrength: bedrock.ContentFilterStrength.LOW,
            outputStrength: bedrock.ContentFilterStrength.LOW,
        });
        guardrails.addContentFilter({
            type: bedrock.ContentFilterType.VIOLENCE,
            inputStrength: bedrock.ContentFilterStrength.LOW,
            outputStrength: bedrock.ContentFilterStrength.LOW,
        });
        // Create a version for deployment - we'll use DRAFT to always get the latest version
        const guardrailVersion = 'DRAFT';
        // Create a Lambda Layer with AWS Distro for OpenTelemetry Lambda
        // https://aws-otel.github.io/docs/getting-started/lambda/lambda-js
        const powertoolsLayer = aws_lambda_1.LayerVersion.fromLayerVersionArn(this, 'ADOTJSLayer', `arn:aws:lambda:${aws_cdk_lib_1.Stack.of(this).region}:901920570463:layer:aws-otel-nodejs-amd64-ver-1-30-1:2`);
        // Create Lambda function
        const chatFunction = new lambda.Function(this, 'ChatFunction', {
            runtime: lambda.Runtime.NODEJS_18_X,
            code: lambda.Code.fromAsset(path.join(__dirname, '../../src/backend')),
            handler: 'index.handler',
            timeout: aws_cdk_lib_1.Duration.minutes(5), // Extended for streaming responses
            tracing: lambda.Tracing.ACTIVE, // Enable tracing
            environment: {
                TABLE_NAME: chatTable.tableName,
                GUARDRAIL_ID: guardrails.guardrailId,
                GUARDRAIL_VERSION: guardrailVersion,
                AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-handler'
            }, // Thanks to AWS_LAMBDA_EXEC_WRAPPER, Lambda execution is traced by otel-hander.
            layers: [powertoolsLayer]
        });
        // Add required permissions for Application Signals
        (_a = chatFunction.role) === null || _a === void 0 ? void 0 : _a.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLambdaApplicationSignalsExecutionRolePolicy'));
        // Grant Lambda permissions to access DynamoDB
        chatTable.grantReadWriteData(chatFunction);
        // Grant Lambda permissions to access all Amazon Bedrock models
        chatFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                'bedrock:InvokeModel',
                'bedrock:InvokeModelWithResponseStream',
                'bedrock:ApplyGuardrail'
            ],
            resources: [
                `arn:aws:bedrock:${cdk.Stack.of(this).region}::foundation-model/*`,
                guardrails.guardrailArn
            ],
        }));
        // Create Endpoint by Function URL
        const functionUrl = chatFunction.addFunctionUrl({
            authType: lambda.FunctionUrlAuthType.NONE, // For demo purposes only, use AWS_IAM in production
            cors: {
                allowedOrigins: ['*'], // Restrict in production
                allowedMethods: [lambda.HttpMethod.ALL],
                allowedHeaders: ['*'],
            },
        });
        // Create S3 bucket for frontend hosting
        const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            websiteIndexDocument: 'index.html',
            websiteErrorDocument: 'index.html',
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });
        // Create CloudFront distribution
        const distribution = new cloudfront.Distribution(this, 'Distribution', {
            defaultBehavior: {
                origin: origins.S3BucketOrigin.withOriginAccessControl(websiteBucket),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
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
        // Deploy frontend to S3
        new s3deploy.BucketDeployment(this, 'DeployWebsite', {
            sources: [s3deploy.Source.asset(path.join(__dirname, '../../src/frontend/build'))],
            destinationBucket: websiteBucket,
            distribution,
            distributionPaths: ['/*'],
        });
        // Output the Function URL and CloudFront URL for easy access
        new cdk.CfnOutput(this, 'ChatFunctionUrl', {
            value: functionUrl.url,
            description: 'URL for the chat Lambda function',
        });
        new cdk.CfnOutput(this, 'CloudFrontUrl', {
            value: `https://${distribution.distributionDomainName}`,
            description: 'URL for the frontend application',
        });
    }
}
exports.LlmObservabilityStack = LlmObservabilityStack;
