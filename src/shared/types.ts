export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ChatSession {
  id: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ChatRequest {
  sessionId?: string;
  message: string;
  modelId: string;
  history?: ChatMessage[];
}

export interface ChatResponse {
  message: ChatMessage;
  sessionId: string;
  guardrailsScores?: {
    harmful: number;
    hateful: number;
    sexual: number;
    toxic: number;
  };
}

export interface GuardrailsResult {
  contentFilterResults: {
    harmful: {
      filtered: boolean;
      score: number;
    };
    hateful: {
      filtered: boolean;
      score: number;
    };
    sexual: {
      filtered: boolean;
      score: number;
    };
    toxic: {
      filtered: boolean;
      score: number;
    };
  };
}