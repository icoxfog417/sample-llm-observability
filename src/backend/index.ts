import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { 
  BedrockRuntimeClient, 
  InvokeModelCommand, 
  ApplyGuardrailCommand,
  GuardrailContentBlock,
  GuardrailContentPolicyAction,
  AccessDeniedException,
  ResourceNotFoundException,
  ServiceQuotaExceededException,
  ThrottlingException,
  InternalServerException
} from '@aws-sdk/client-bedrock-runtime';
import { v4 as uuidv4 } from 'uuid';
import * as api from '@opentelemetry/api';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// Initialize clients
const dynamoClient = new DynamoDBClient();
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const bedrockClient = new BedrockRuntimeClient();

// Environment variables
const TABLE_NAME = process.env.TABLE_NAME || '';
const GUARDRAIL_ID = process.env.GUARDRAIL_ID || '';
const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION || 'DRAFT';

// Define interfaces for our application
interface ContentFilterResult {
  filtered: boolean;
  score: number;
}

interface ContentFilterResults {
  harmful: ContentFilterResult;
  hateful: ContentFilterResult;
  sexual: ContentFilterResult;
  toxic: ContentFilterResult;
}

interface GuardrailsResult {
  contentFilterResults: ContentFilterResults;
  error?: string;
  [key: string]: any; // Allow for additional properties from the AWS response
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  sessionId?: string;
}

interface GuardrailsScores {
  harmful: number;
  hateful: number;
  sexual: number;
  toxic: number;
}

/**
 * Apply guardrails to content
 * @param content - The content to check
 * @param source - The source of the content ('INPUT' or 'OUTPUT')
 * @returns Guardrails result
 */
async function applyGuardrails(content: string, source: 'INPUT' | 'OUTPUT' = 'INPUT'): Promise<GuardrailsResult> {
  try {
    // Create the command with proper typing for the content parameter
    const command = new ApplyGuardrailCommand({
      guardrailIdentifier: GUARDRAIL_ID,
      guardrailVersion: GUARDRAIL_VERSION,
      content: [{ 
        text: {
          text: content
        }
      }],
      source: source,
      outputScope: 'FULL' // Get full output for enhanced debugging
    });
    
    const response = await bedrockClient.send(command);
    
    // Process the response to extract content filter scores
    // Map to the expected structure in our application
    const contentFilterResults: ContentFilterResults = {
      harmful: { filtered: false, score: 0 },
      hateful: { filtered: false, score: 0 },
      sexual: { filtered: false, score: 0 },
      toxic: { filtered: false, score: 0 }
    };
    
    // Extract scores from the assessments array if it exists
    if (response.assessments && response.assessments.length > 0) {
      const assessment = response.assessments[0];
      
      // Process content policy filters
      if (assessment.contentPolicy && assessment.contentPolicy.filters) {
        assessment.contentPolicy.filters.forEach(filter => {
          // Map filter types to our application's expected structure
          // HATE -> hateful, SEXUAL -> sexual, VIOLENCE -> harmful
          if (filter.type === 'HATE') {
            contentFilterResults.hateful = {
              filtered: filter.action === GuardrailContentPolicyAction.BLOCKED,
              score: parseFloat(filter.confidence || '0')
            };
          } else if (filter.type === 'SEXUAL') {
            contentFilterResults.sexual = {
              filtered: filter.action === GuardrailContentPolicyAction.BLOCKED,
              score: parseFloat(filter.confidence || '0')
            };
          } else if (filter.type === 'VIOLENCE') {
            contentFilterResults.harmful = {
              filtered: filter.action === GuardrailContentPolicyAction.BLOCKED,
              score: parseFloat(filter.confidence || '0')
            };
          } else if (filter.type === 'INSULTS') {
            contentFilterResults.toxic = {
              filtered: filter.action === GuardrailContentPolicyAction.BLOCKED,
              score: parseFloat(filter.confidence || '0')
            };
          }
        });
      }
    }
    
    // Return the processed response with our application's expected structure
    return {
      ...response,
      contentFilterResults
    };
  } catch (error) {
    console.error('Error applying guardrails:', error);
    
    let errorMessage = 'An error occurred while applying guardrails';
    
    // Handle specific error types with proper TypeScript instanceof checks
    if (error instanceof AccessDeniedException) {
      errorMessage = 'Access denied: Insufficient permissions to apply guardrails';
      console.error('AccessDeniedException: Check IAM permissions for bedrock:ApplyGuardrail');
    } else if (error instanceof ResourceNotFoundException) {
      errorMessage = 'Guardrail not found: The specified guardrail ID or version does not exist';
      console.error(`ResourceNotFoundException: Check if guardrail ID ${GUARDRAIL_ID} and version ${GUARDRAIL_VERSION} exist`);
    } else if (error instanceof ServiceQuotaExceededException) {
      errorMessage = 'Service quota exceeded: Request exceeds the service quota for your account';
      console.error('ServiceQuotaExceededException: Consider requesting a quota increase');
    } else if (error instanceof ThrottlingException) {
      errorMessage = 'Request throttled: Too many requests in a short period';
      console.error('ThrottlingException: Implement retry logic with exponential backoff');
    } else if (error instanceof InternalServerException) {
      errorMessage = 'Internal server error: An issue occurred on the AWS side';
      console.error('InternalServerException: This is an AWS internal issue, not client-side');
    }
    
    // Return a default response if guardrails fail
    return {
      error: errorMessage,
      contentFilterResults: {
        harmful: { filtered: false, score: 0 },
        hateful: { filtered: false, score: 0 },
        sexual: { filtered: false, score: 0 },
        toxic: { filtered: false, score: 0 }
      }
    };
  }
}

/**
 * Invoke Bedrock model
 * @param modelId - The model ID to use
 * @param messages - The chat messages
 * @returns Model response
 */
async function invokeModel(modelId: string, messages: ChatMessage[]): Promise<string> {
  // Create a span for model invocation
  const tracer = api.trace.getTracer('llm-observability-backend');
  const span = tracer.startSpan(`bedrock.invoke.${modelId}`);
  
  // Add attributes to the span
  span.setAttribute('llm.model_id', modelId);
  span.setAttribute('llm.messages_count', messages.length);
  
  try {
    // Format messages based on the model
    let body: any;
    
    if (modelId.includes('claude')) {
      // Claude format
      body = {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1000,
        messages: messages.map(msg => ({
          role: msg.role,
          content: msg.content
        }))
      };
    } else if (modelId.includes('llama')) {
      // Llama format
      body = {
        prompt: messages.map(msg => `<${msg.role}>${msg.content}</${msg.role}>`).join('\n'),
        max_gen_len: 1000,
        temperature: 0.7
      };
    } else {
      // Default format for other models
      body = {
        prompt: messages.map(msg => `${msg.role}: ${msg.content}`).join('\n'),
        max_tokens: 1000,
        temperature: 0.7
      };
    }

    const command = new InvokeModelCommand({
      modelId: modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body)
    });

    const response = await bedrockClient.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    
    // Extract response based on model
    let content = '';
    if (modelId.includes('claude')) {
      content = responseBody.content[0].text;
    } else if (modelId.includes('llama')) {
      content = responseBody.generation;
    } else {
      content = responseBody.completion || responseBody.text || responseBody.generated_text || '';
    }
    
    span.setAttribute('llm.response_length', content.length);
    span.end();
    return content;
  } catch (error) {
    console.error('Error invoking model:', error);
    span.recordException(error as Error);
    span.setStatus({ code: api.SpanStatusCode.ERROR, message: (error as Error).message });
    span.end();
    throw error;
  }
}

/**
 * Store message in DynamoDB
 * @param message - The message to store
 * @param sessionId - The session ID
 */
async function storeMessage(message: ChatMessage, sessionId: string): Promise<void> {
  try {
    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...message,
        sessionId
      }
    });
    
    await docClient.send(command);
  } catch (error) {
    console.error('Error storing message:', error);
    throw error;
  }
}

/**
 * Get session messages
 * @param sessionId - The session ID
 * @returns Session messages
 */
async function getSessionMessages(sessionId: string): Promise<ChatMessage[]> {
  try {
    const command = new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'id = :sessionId',
      ExpressionAttributeValues: {
        ':sessionId': sessionId
      },
      ScanIndexForward: true // Sort by timestamp ascending
    });
    
    const response = await docClient.send(command);
    return response.Items as ChatMessage[] || [];
  } catch (error) {
    console.error('Error getting session messages:', error);
    return [];
  }
}

/**
 * Lambda handler
 * @param event - API Gateway event
 * @returns API Gateway response
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // Create a span for the entire request
  const tracer = api.trace.getTracer('llm-observability-backend');
  const span = tracer.startSpan('lambda.handler');
  
  // Extract request ID if available
  const requestId = event.requestContext?.requestId;
  if (requestId) {
    span.setAttribute('aws.request_id', requestId);
  }
  
  try {
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    
    // Always generate a new session ID on the server if not provided
    // This ensures session IDs are securely generated on the server side
    const sessionId = body.sessionId || uuidv4();
    
    // Add session ID to the span
    span.setAttribute('llm.session_id', sessionId);
    
    const { message, modelId, history = [] } = body;
    
    // Create user message
    const userMessage: ChatMessage = {
      id: sessionId,
      timestamp: Date.now(),
      role: 'user',
      content: message
    };
    
    // Apply guardrails to user message
    const userGuardrailsResult = await applyGuardrails(message, 'INPUT');
    
    // Check if user message is filtered
    const isUserMessageFiltered = Object.values(userGuardrailsResult.contentFilterResults || {})
      .some(filter => filter.filtered === true);
    
    if (isUserMessageFiltered) {
      // End the span before returning error response
      span.end();
      
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
          error: 'Your message was filtered by content safety guardrails',
          sessionId, // Return the session ID to the client
          guardrailsScores: {
            harmful: userGuardrailsResult.contentFilterResults?.harmful?.score || 0,
            hateful: userGuardrailsResult.contentFilterResults?.hateful?.score || 0,
            sexual: userGuardrailsResult.contentFilterResults?.sexual?.score || 0,
            toxic: userGuardrailsResult.contentFilterResults?.toxic?.score || 0
          }
        })
      };
    }
    
    // Store user message
    await storeMessage(userMessage, sessionId);
    
    // Get conversation history or use provided history
    let messages = history.length > 0 ? history : await getSessionMessages(sessionId);
    
    // Add current user message if not in history
    if (!messages.some((msg: ChatMessage) => msg.content === message && msg.role === 'user')) {
      messages.push(userMessage);
    }
    
    // Invoke model
    const modelResponse = await invokeModel(modelId, messages);
    
    // Apply guardrails to model response
    const modelGuardrailsResult = await applyGuardrails(modelResponse, 'OUTPUT');
    
    // Check if model response is filtered
    const isModelResponseFiltered = Object.values(modelGuardrailsResult.contentFilterResults || {})
      .some(filter => filter.filtered === true);
    
    // Create assistant message
    const assistantMessage: ChatMessage = {
      id: sessionId,
      timestamp: Date.now(),
      role: 'assistant',
      content: isModelResponseFiltered ? 
        "I'm sorry, but I cannot provide a response to that query as it may contain inappropriate content." : 
        modelResponse
    };
    
    // Store assistant message
    await storeMessage(assistantMessage, sessionId);
    
    // End the span before returning success response
    span.end();
    
    // Return response
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        message: assistantMessage,
        sessionId, // Always return the session ID to the client
        guardrailsScores: {
          harmful: modelGuardrailsResult.contentFilterResults?.harmful?.score || 0,
          hateful: modelGuardrailsResult.contentFilterResults?.hateful?.score || 0,
          sexual: modelGuardrailsResult.contentFilterResults?.sexual?.score || 0,
          toxic: modelGuardrailsResult.contentFilterResults?.toxic?.score || 0
        }
      })
    };
  } catch (error) {
    console.error('Error processing request:', error);
    
    // Record the error in the span
    span.recordException(error as Error);
    span.setStatus({ code: api.SpanStatusCode.ERROR, message: (error as Error).message });
    span.end();
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'An error occurred while processing your request',
        message: (error as Error).message
      })
    };
  }
};
