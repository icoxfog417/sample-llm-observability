import React, { useState, useEffect, useRef } from 'react';
import Markdown from 'react-markdown';
import { sendChatMessage, getAvailableModels } from '../services/api';
import { ChatMessage } from '../../../shared/types';
import './Chat.css';

// Generate a simple ID for UI purposes only
let messageCounter = 0;
const generateLocalId = () => `local-${Date.now()}-${messageCounter++}`;

const Chat: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState(getAvailableModels()[0]?.id);
  const [guardrailsScores, setGuardrailsScores] = useState<{
    harmful: number;
    hateful: number;
    sexual: number;
    toxic: number;
  } | null>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const availableModels = getAvailableModels();

  // Scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim()) return;
    
    // Generate a simple local ID for UI purposes only
    const messageId = generateLocalId();
    
    // Add user message to chat
    const userMessage: ChatMessage = {
      id: messageId,
      role: 'user',
      content: input,
      timestamp: Date.now()
    };
    
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    
    try {
      const response = await sendChatMessage({
        sessionId: sessionId || undefined, // Convert null to undefined to match the type
        message: input,
        modelId: selectedModel,
        history: messages
      });
      
      // Store the session ID returned from the server
      if (response.sessionId && (!sessionId || sessionId !== response.sessionId)) {
        setSessionId(response.sessionId);
      }
      
      // Add assistant message to chat with a local ID
      const assistantMessage: ChatMessage = {
        ...response.message,
        id: generateLocalId() // Simple ID for UI purposes only
      };
      
      setMessages(prev => [...prev, assistantMessage]);
      
      // Update guardrails scores
      if (response.guardrailsScores) {
        setGuardrailsScores(response.guardrailsScores);
      }
    } catch (error: unknown) {
      console.error('Error sending message:', error instanceof Error ? error.message : String(error));
      
      // Add error message with a local ID
      setMessages(prev => [
        ...prev,
        {
          id: generateLocalId(),
          role: 'assistant',
          content: 'Sorry, there was an error processing your request.',
          timestamp: Date.now()
        }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const formatScore = (score: number) => {
    return (score * 100).toFixed(1) + '%';
  };

  return (
    <div className="chat-container">
      <div className="row">
        <div className="col s12">
          <div className="card">
            <div className="card-content">
              <div className="chat-header">
                <span className="card-title">LLM Observability Demo</span>
                <div className="input-field model-selector">
                  <select
                    id="model-select"
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="browser-default"
                  >
                    {availableModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                  <label htmlFor="model-select" className="active">Model</label>
                </div>
              </div>

              <div className="messages-container z-depth-1">
                {messages.length === 0 ? (
                  <div className="empty-state">
                    <p>Send a message to start chatting!</p>
                  </div>
                ) : (
                  messages.map((msg) => (
                    <div
                      key={msg.id} // Using the local message ID as key
                      className={`message ${msg.role === 'user' ? 'user-message' : 'assistant-message'}`}
                    >
                      <div className="message-content">
                        <Markdown>{msg.content}</Markdown>
                      </div>
                    </div>
                  ))
                )}
                {loading && (
                  <div className="message assistant-message">
                    <div className="message-content">
                      <div className="typing-indicator">
                        <span></span>
                        <span></span>
                        <span></span>
                      </div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {guardrailsScores && (
                <div className="guardrails-scores card-panel">
                  <h5>Content Safety Scores</h5>
                  <div className="scores-grid">
                    <div className="score-item">
                      <label>Harmful:</label>
                      <div className="progress score-bar">
                        <div
                          className="determinate"
                          style={{ width: `${guardrailsScores.harmful * 100}%` }}
                        ></div>
                      </div>
                      <span>{formatScore(guardrailsScores.harmful)}</span>
                    </div>
                    <div className="score-item">
                      <label>Hateful:</label>
                      <div className="progress score-bar">
                        <div
                          className="determinate"
                          style={{ width: `${guardrailsScores.hateful * 100}%` }}
                        ></div>
                      </div>
                      <span>{formatScore(guardrailsScores.hateful)}</span>
                    </div>
                    <div className="score-item">
                      <label>Sexual:</label>
                      <div className="progress score-bar">
                        <div
                          className="determinate"
                          style={{ width: `${guardrailsScores.sexual * 100}%` }}
                        ></div>
                      </div>
                      <span>{formatScore(guardrailsScores.sexual)}</span>
                    </div>
                    <div className="score-item">
                      <label>Toxic:</label>
                      <div className="progress score-bar">
                        <div
                          className="determinate"
                          style={{ width: `${guardrailsScores.toxic * 100}%` }}
                        ></div>
                      </div>
                      <span>{formatScore(guardrailsScores.toxic)}</span>
                    </div>
                  </div>
                </div>
              )}

              <div className="input-container row">
                <div className="input-field col s10">
                  <textarea
                    id="message-input"
                    className="materialize-textarea"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Type your message..."
                    disabled={loading}
                  ></textarea>
                </div>
                <div className="col s2">
                  <button 
                    className="btn waves-effect waves-light"
                    onClick={handleSend} 
                    disabled={loading || !input.trim()}
                  >
                    Send
                    <i className="material-icons right">send</i>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Chat;