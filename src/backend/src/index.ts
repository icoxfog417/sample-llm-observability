import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { 
  BedrockRuntimeClient, 
  ConverseCommand,
  ApplyGuardrailCommand,
  GuardrailContentPolicyAction,
  GuardrailContentFilterConfidence,
  ConversationRole,
  AccessDeniedException,
  ResourceNotFoundException,
  ServiceQuotaExceededException,
  ThrottlingException,
  InternalServerException
} from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'crypto';
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

// Define Trace name
const TRACE_NAME = 'llm-observability-backend';

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

/**
 * Apply guardrails to content
 * @param content - The content to check
 * @param source - The source of the content ('INPUT' or 'OUTPUT')
 * @returns Guardrails result
 */
export async function applyGuardrails(content: string, source: 'INPUT' | 'OUTPUT' = 'INPUT'): Promise<GuardrailsResult> {
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
    
    // Function to convert GuardrailContentFilterConfidence to number (Value is HIGH, MEDIUM, LOW, NONE)
    const convertConfidenceToNumber = (confidence?: GuardrailContentFilterConfidence): number => {
      if (!confidence) {
        return 0.0;
      }
      switch (confidence) {
        case GuardrailContentFilterConfidence.HIGH:
          return 1.0;
        case GuardrailContentFilterConfidence.MEDIUM:
          return 0.7;
        case GuardrailContentFilterConfidence.LOW:
          return 0.3;
        case GuardrailContentFilterConfidence.NONE:
          return 0.0;
        default:
          return 0.0; // Default to 0 if unknown confidence level
      }
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
              score: convertConfidenceToNumber(filter.confidence)
            };
          } else if (filter.type === 'SEXUAL') {
            contentFilterResults.sexual = {
              filtered: filter.action === GuardrailContentPolicyAction.BLOCKED,
              score: convertConfidenceToNumber(filter.confidence)
            };
          } else if (filter.type === 'VIOLENCE') {
            contentFilterResults.harmful = {
              filtered: filter.action === GuardrailContentPolicyAction.BLOCKED,
              score: convertConfidenceToNumber(filter.confidence)
            };
          } else if (filter.type === 'INSULTS') {
            contentFilterResults.toxic = {
              filtered: filter.action === GuardrailContentPolicyAction.BLOCKED,
              score: convertConfidenceToNumber(filter.confidence)
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
 * Invoke Bedrock model using the Converse API
 * @param modelId - The model ID to use
 * @param messages - The chat messages
 * @returns Model response
 */
async function invokeModel(modelId: string, messages: ChatMessage[]): Promise<string> {
  // Create a span for model invocation
  const tracer = api.trace.getTracer(TRACE_NAME);
  const span = tracer.startSpan(`Bedrock.converse.${modelId}`);
  
  // Add attributes to the span
  span.setAttribute('llm.model_id', modelId);
  
  try {
    // Convert our application's message format to the Converse API format
    const converseMessages = messages.map(msg => {
      // Map our application roles to ConversationRole enum
      // Note: ConversationRole only has USER and ASSISTANT, no SYSTEM
      let role: ConversationRole;
      if (msg.role === 'user') {
        role = ConversationRole.USER;
      } else {
        // Default to ASSISTANT for both 'assistant' and 'system' roles
        // System messages will be treated as assistant messages in the Converse API
        role = ConversationRole.ASSISTANT;
      }
      
      return {
        role,
        content: [{ text: msg.content }]
      };
    });

    // Create a command with unified format for all models
    const command = new ConverseCommand({
      modelId: modelId,
      messages: converseMessages,
      inferenceConfig: {
        maxTokens: 1000,
        temperature: 0.7,
        topP: 0.9
      }
    });

    // Send the command to the model
    const response = await bedrockClient.send(command);
    
    // Extract the response text from the standardized Converse API response
    const content = response.output?.message?.content?.[0]?.text || '';
    span.setAttribute('llm.input_tokens', response.usage?.inputTokens || 0);
    span.setAttribute('llm.output_tokens', response.usage?.outputTokens || 0);
    span.setAttribute('llm.total_tokens', response.usage?.totalTokens || 0);
    span.setAttribute('llm.cache_read', response.usage?.cacheReadInputTokens || 0);
    span.setAttribute('llm.cache_write', response.usage?.cacheWriteInputTokens || 0);    
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
  const tracer = api.trace.getTracer(TRACE_NAME);
  const meter = api.metrics.getMeter(TRACE_NAME);
  const currentSpan = api.trace.getActiveSpan() || tracer.startSpan(TRACE_NAME);
  
  try {
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    
    // Always generate a new session ID on the server if not provided
    // This ensures session IDs are securely generated on the server side
    const sessionId = body.sessionId || randomUUID();
    
    // Add session ID to the span
    currentSpan.setAttribute('llm.session_id', sessionId);
  
    const { message, modelId, history = [] } = body;
    
    // Create user message
    const userMessage: ChatMessage = {
      id: sessionId,
      timestamp: Date.now(),
      role: 'user',
      content: message
    };
      
    // Apply guardrails to user message
    const userGuardrailsResult = await tracer.startActiveSpan('Guardrails-INPUT', async (span : api.Span) => {
      span.setAttribute('guardrails.id', GUARDRAIL_ID);
      span.setAttribute('guardrails.version', GUARDRAIL_VERSION);
      const result = await applyGuardrails(message, 'INPUT');
      const totalScore = Object.values(result.contentFilterResults || {}).reduce((acc, filter) => acc + (filter.score || 0), 0);
      if (totalScore > 0) {
        span.setStatus({ code: api.SpanStatusCode.ERROR, message: 'User message filtered' });
        span.setAttribute('guardrails.input', message);
      }
      span.end();
      return result;
    });
    
    // Check if user message is filtered
    const isUserMessageFiltered = Object.values(userGuardrailsResult.contentFilterResults || {})
      .some(filter => filter.filtered === true);
    
    if (isUserMessageFiltered) {
      const assistantRefusalMessage: ChatMessage = {
        id: sessionId,
        timestamp: Date.now(),
        role: 'assistant',
        content: 'Your message was filtered by content safety guardrails.'
      };
      

      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
          message: assistantRefusalMessage,
          sessionId, // Always return the session ID to the client
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
    const modelGuardrailsResult = await tracer.startActiveSpan('Guardrails-OUTPUT', async (span : api.Span) => {
      span.setAttribute('guardrails.id', GUARDRAIL_ID);
      span.setAttribute('guardrails.version', GUARDRAIL_VERSION);
      const result = await applyGuardrails(modelResponse, 'OUTPUT');
      const totalScore = Object.values(result.contentFilterResults || {}).reduce((acc, filter) => acc + (filter.score || 0), 0);
      if (totalScore > 0) {
        span.setStatus({ code: api.SpanStatusCode.ERROR, message: 'User message filtered' });
        span.setAttribute('guardrails.output', modelResponse);
      }
      span.end();
      return result;
    })
  
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
    currentSpan.recordException(error as Error);
    currentSpan.setStatus({ code: api.SpanStatusCode.ERROR, message: (error as Error).message });
    
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
