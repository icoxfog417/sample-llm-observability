import { ChatRequest, ChatResponse } from '../../../shared/types';
import { config } from '../config';

/**
 * Send a chat message to the backend
 * @param request Chat request object
 * @returns Promise with the chat response
 */
export async function sendChatMessage(request: ChatRequest): Promise<ChatResponse> {
  const response = await fetch(`${config.apiUrl}`, {
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
    { id: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0', name: 'Claude (3.7)' },
    { id: 'us.amazon.nova-pro-v1:0', name: 'Amazon Nova (Pro)' }
  ];
}