import React, { useEffect, useState } from 'react';
import Chat from './components/Chat';
import { config } from './config';
import './App.css';

function App() {
  const [isConfigLoaded, setIsConfigLoaded] = useState(false);
  
  useEffect(() => {
    // Check if API URL is configured
    if (config.apiUrl) {
      console.log('API URL configured:', config.apiUrl);
      setIsConfigLoaded(true);
    } else {
      console.warn('API URL is not configured. The application may not function correctly.');
      // Still set to true to show the app, but with a warning
      setIsConfigLoaded(true);
    }
  }, []);

  if (!isConfigLoaded) {
    return <div className="App">Loading configuration...</div>;
  }

  return (
    <div className="App">
      <Chat />
    </div>
  );
}

export default App;