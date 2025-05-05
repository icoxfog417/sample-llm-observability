import { ChatRequest, ChatResponse } from '../../../shared/types';

// Function to get the API URL from different sources
function getApiUrl(): string {
  // First check for runtime config (useful for production)
  if (window.REACT_APP_API_URL) {
    return window.REACT_APP_API_URL;
  }
  
  // Then check for environment variables (useful for development)
  if (process.env.REACT_APP_API_URL) {
    return process.env.REACT_APP_API_URL;
  }
  
  // Fallback to empty string, but log a warning
  console.warn('API URL is not configured. The API calls will fail.');
  return '';
}

// Get the API URL
const API_URL = getApiUrl();

/**
 * Send a chat message to the backend
 * @param request Chat request object
 * @returns Promise with the chat response
 */
export async function sendChatMessage(request: ChatRequest): Promise<ChatResponse> {
  const response = await fetch(`${API_URL}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(errorData.error || `Failed to send message: ${response.status}`);
  }

  return response.json();
}

/**
 * Get available Bedrock models
 * This is a mock function - in a real app, you might fetch this from the backend
 */
export function getAvailableModels(): { id: string; name: string }[] {
  return [
    { id: 'anthropic.claude-v2', name: 'Claude V2' },
    { id: 'anthropic.claude-instant-v1', name: 'Claude Instant' },
    { id: 'amazon.titan-text-express-v1', name: 'Amazon Titan' },
    { id: 'meta.llama2-13b-chat-v1', name: 'Llama 2 (13B)' },
  ];
}

// Add this to the global window object for TypeScript
declare global {
  interface Window {
    REACT_APP_API_URL?: string;
  }
}