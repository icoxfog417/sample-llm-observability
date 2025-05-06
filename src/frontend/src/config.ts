/**
 * Configuration module for the application
 * Uses hardcoded values for production and environment variables for development
 */

// Define the shape of our configuration
export interface AppConfig {
  apiUrl: string;
  region: string;
  // Add any other configuration values here
}

// Configuration for the application
// In production, API URL is relative to the current domain
const config: AppConfig = {
  apiUrl: process.env.ROOT_URL || '/api',
  region: process.env.REACT_APP_REGION || 'us-east-1',
};

// Export the configuration
export { config };
