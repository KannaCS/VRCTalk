import React, { useState, useEffect } from 'react';
import { loadConfig, Config } from '../utils/config';
import VRCTalk from './VRCTalk';
import Settings from './Settings';
import { info, error } from '@tauri-apps/plugin-log';

// Message record type for history
type MessageItem = { src: string; tgt: string; time: number };

const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<MessageItem[]>([]);
  const [showHistory, setShowHistory] = useState<boolean>(false);

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

  // Handle history toggle
  const handleHistoryToggle = () => {
    setShowHistory(!showHistory);
  };

  // Callback from VRCTalk to add message to history
  const handleNewMessage = (src: string, tgt: string) => {
    setHistory(prev => [{ src, tgt, time: Date.now() }, ...prev].slice(0, 200));
  };

  if (loading || !config) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden">
        {/* Animated Background */}
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-950 via-indigo-900 to-indigo-800">
          <div className="absolute inset-0 opacity-20" style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.05'%3E%3Ccircle cx='30' cy='30' r='2'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`
          }}></div>
          
          {/* Floating Orbs */}
          <div className="absolute top-1/4 left-1/4 w-32 h-32 bg-blue-500/20 rounded-full blur-xl animate-float"></div>
          <div className="absolute top-3/4 right-1/4 w-24 h-24 bg-purple-500/20 rounded-full blur-xl animate-float animate-delay-300"></div>
          <div className="absolute bottom-1/4 left-1/3 w-20 h-20 bg-pink-500/20 rounded-full blur-xl animate-float animate-delay-500"></div>
        </div>

        {/* Loading Content */}
        <div className="relative z-10 text-center">
          <div className="modern-card animate-scale-in max-w-md mx-auto">
            {/* Logo Animation */}
            <div className="flex justify-center mb-8">
              <div className="relative">
                <div className="w-20 h-20 rounded-2xl bg-blue-600 flex items-center justify-center animate-pulse-soft">
                  <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path>
                  </svg>
                </div>
                
                {/* Pulsing Rings */}
                <div className="absolute inset-0 rounded-2xl border-2 border-blue-400/50 animate-ping"></div>
                <div className="absolute inset-0 rounded-2xl border-2 border-purple-400/30 animate-ping animate-delay-200"></div>
              </div>
            </div>

            {/* Loading Text */}
            <div className="space-y-4">
              <h2 className="text-3xl font-bold text-white animate-slide-up">
                VRC<span style={{color:'var(--secondary-color)'}}>Talk</span>
              </h2>
              <p className="text-white/80 animate-slide-up animate-delay-100">
                Initializing voice translation system...
              </p>
              
              {/* Loading Progress */}
              <div className="mt-8 animate-slide-up animate-delay-200">
                <div className="progress-bar">
                  <div className="progress-fill w-full"></div>
                </div>
              </div>

              {/* Loading Dots */}
              <div className="flex justify-center space-x-2 mt-6 animate-slide-up animate-delay-300">
                <div className="w-2 h-2 rounded-full bg-blue-400 animate-bounce"></div>
                <div className="w-2 h-2 rounded-full bg-purple-400 animate-bounce animate-delay-100"></div>
                <div className="w-2 h-2 rounded-full bg-pink-400 animate-bounce animate-delay-200"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen relative overflow-hidden">
      {/* Dynamic Background */}
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-950 via-indigo-900 to-indigo-800">
        <div className="absolute inset-0 opacity-30" style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.03'%3E%3Ccircle cx='30' cy='30' r='2'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`
        }}></div>
        
        {/* Animated Background Elements */}
        <div className="absolute top-0 left-0 w-full h-full overflow-hidden">
          <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl animate-float"></div>
          <div className="absolute top-1/2 right-1/4 w-48 h-48 bg-purple-500/10 rounded-full blur-3xl animate-float animate-delay-300"></div>
          <div className="absolute bottom-1/4 left-1/2 w-32 h-32 bg-pink-500/10 rounded-full blur-3xl animate-float animate-delay-500"></div>
        </div>
      </div>

      {/* Header */}
      <header className="relative z-10 app-header py-2">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex justify-between items-center">
            {/* Logo and Title */}
            <div className="flex items-center space-x-4 animate-slide-down">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{background:'var(--primary-color)'}}>
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path>
                </svg>
              </div>
              <div>
                <h1 className="text-xl font-bold text-white">
                  VRC<span style={{color:'var(--secondary-color)'}}>Talk</span>
                </h1>
                <p className="text-white/60 text-xs">Voice Translation for VRChat</p>
              </div>
            </div>

            {/* Version, History, Settings */}
            <div className="flex items-center space-x-4 animate-slide-down animate-delay-100">
              <span className="px-3 py-1 bg-white/10 text-white/80 text-xs font-medium rounded-full backdrop-blur-sm">
                v0.2.2
              </span>

              {/* History Button */}
              <button 
                onClick={handleHistoryToggle}
                className="btn-modern flex items-center space-x-2 text-sm"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3"></path>
                  <circle cx="12" cy="12" r="10" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>History</span>
              </button>
              <button 
                onClick={handleSettingsToggle}
                className="btn-modern flex items-center space-x-2 text-sm"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                </svg>
                <span>Settings</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-10 flex-1 px-3 py-2 sm:px-4 sm:py-3 lg:px-6 lg:py-4">
        <div className="max-w-4xl mx-auto">
          <div className="animate-fade-in">
            <VRCTalk config={config} setConfig={setConfig} onNewMessage={handleNewMessage} />
          </div>
        </div>
      </main>

      {/* Settings Modal */}
      {showSettings && (
        <div className="modal-backdrop animate-fade-in" onClick={handleSettingsToggle}>
          <div 
            className="modal-content animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex justify-between items-center p-4 border-b border-white/10">
              <div>
                <h2 className="text-xl font-bold text-white">Settings</h2>
                <p className="text-white/60 text-sm mt-1">Configure your VRCTalk experience</p>
              </div>
              <button 
                onClick={handleSettingsToggle}
                className="p-2 rounded-xl text-white/60 hover:text-white hover:bg-white/10 transition-all duration-300"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-4 overflow-y-auto max-h-[calc(90vh-100px)]">
              <Settings 
                config={config} 
                setConfig={setConfig} 
                onClose={handleSettingsToggle} 
              />
            </div>
          </div>
        </div>
      )}

      {/* History Modal */}
      {showHistory && (
        <div className="modal-backdrop animate-fade-in" onClick={handleHistoryToggle}>
          <div 
            className="modal-content animate-scale-in max-w-lg w-full"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex justify-between items-center p-4 border-b border-white/10">
              <h2 className="text-xl font-bold text-white">Message History</h2>
              <button 
                onClick={handleHistoryToggle}
                className="p-2 rounded-xl text-white/60 hover:text-white hover:bg-white/10 transition-all duration-300"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-4 overflow-y-auto max-h-[70vh] space-y-3">
              {history.length === 0 ? (
                <p className="text-white/70 text-sm">No messages yet.</p>
              ) : (
                history.map((item, idx) => (
                  <div key={idx} className="bg-white/5 p-3 rounded-lg">
                    <p className="text-xs text-blue-300 mb-1">{new Date(item.time).toLocaleTimeString()}</p>
                    <p className="text-sm text-white break-words"><span className="font-semibold">Src:</span> {item.src}</p>
                    <p className="text-sm text-purple-200 break-words mt-1"><span className="font-semibold">Tgt:</span> {item.tgt}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;