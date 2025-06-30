import React, { useState, useEffect } from 'react';
import { loadConfig, Config } from '../utils/config';
import VRCTalk from './VRCTalk';
import Settings from './Settings';
import { info, error } from '@tauri-apps/plugin-log';

const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const initConfig = async () => {
      try {
        const loadedConfig = await loadConfig();
        setConfig(loadedConfig);
        info('[APP] Configuration loaded successfully');
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        error(`[APP] Failed to load configuration: ${errorMessage}`);
      } finally {
        setLoading(false);
      }
    };

    initConfig();
  }, []);

  // Handle settings dialog open/close with logging
  const handleSettingsToggle = () => {
    try {
      info(`[APP] ${showSettings ? 'Closing' : 'Opening'} settings dialog`);
      setShowSettings(!showSettings);
      info(`[APP] Settings dialog ${showSettings ? 'closed' : 'opened'} successfully`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      error(`[APP] Error toggling settings dialog: ${errorMessage}`);
    }
  };

  if (loading || !config) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-gradient-to-br from-indigo-900 via-blue-900 to-purple-900 text-white">
        <div className="text-center p-8 rounded-lg backdrop-blur-sm bg-black/20 border border-white/10 shadow-xl">
          <div className="flex justify-center mb-6">
            <div className="relative">
              <svg className="w-16 h-16 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path>
              </svg>
              <div className="absolute inset-0 rounded-full border-2 border-blue-400 animate-ping opacity-75"></div>
            </div>
          </div>
          <h2 className="text-2xl font-bold mb-2 animate-pulse">Loading VRCTalk...</h2>
          <p className="text-white/80">Please wait while the application initializes</p>
          
          <div className="mt-6 flex justify-center space-x-2">
            <div className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: "0ms" }}></div>
            <div className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: "150ms" }}></div>
            <div className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: "300ms" }}></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-indigo-900 via-blue-900 to-purple-900 overflow-hidden">
      {/* Header */}
      <header className="py-2 bg-navy-900 bg-opacity-90 shadow-lg border-b border-white/10 flex-shrink-0">
        <div className="flex justify-center items-center">
          <div className="flex flex-row items-center justify-center gap-2">
            <h1 className="text-xl font-bold text-white flex items-center">
              VRC<span className="text-blue-400">Talk</span>
              <span className="ml-1.5 px-1.5 py-0.5 bg-blue-600 text-xs text-white font-medium rounded">v0.1.3</span>
            </h1>
            <button 
              onClick={handleSettingsToggle}
              className="px-3 py-1 rounded-md font-medium transition-all duration-300 text-sm bg-white/10 text-white/80 hover:bg-white/20"
            >
              Settings
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex justify-center overflow-y-auto py-4">
        <div className="w-full max-w-2xl px-4 animate-fade-in">
          <div className="transition-all duration-300 transform">
            <div className="animate-slide-up">
              <VRCTalk config={config} setConfig={setConfig} />
            </div>
          </div>
        </div>
      </main>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
          <div 
            className="bg-gray-900 w-11/12 max-w-2xl max-h-[90vh] rounded-lg shadow-2xl border border-white/10 overflow-hidden animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center border-b border-gray-700 px-4 py-3">
              <h2 className="text-lg font-semibold text-white">Settings</h2>
              <button 
                onClick={handleSettingsToggle}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
            <div className="p-4 overflow-y-auto max-h-[calc(90vh-64px)]">
              <Settings 
                config={config} 
                setConfig={setConfig} 
                onClose={handleSettingsToggle} 
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App; 