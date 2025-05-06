/**
 * Configuration module for the application
 * Reads configuration from window.APP_CONFIG (set by config.js)
 * Falls back to environment variables during development
 */

// Define the shape of our configuration
export interface AppConfig {
  apiUrl: string;
  region: string;
  // Add any other configuration values here
}

// Default configuration (used during development)
const defaultConfig: AppConfig = {
  apiUrl: process.env.REACT_APP_API_URL || '',
  region: process.env.REACT_APP_REGION || 'us-east-1',
};

// Get configuration from window.APP_CONFIG if available
declare global {
  interface Window {
    APP_CONFIG?: AppConfig;
  }
}

// Function to get the configuration
export function getConfig(): AppConfig {
  // Use window.APP_CONFIG if available (production)
  if (window.APP_CONFIG) {
    return window.APP_CONFIG;
  }
  
  // Otherwise use default config (development)
  return defaultConfig;
}

// Export the configuration
export const config = getConfig();
