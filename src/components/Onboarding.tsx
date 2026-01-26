import React, { useState } from 'react';
import { Config, saveConfig } from '../utils/config';
import { info } from '@tauri-apps/plugin-log';
import logo from '../assets/logo.png';

type OnboardingProps = {
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config | null>>;
  onComplete: () => void;
};

type ThemeOption = {
  id: string;
  name: string;
  color: string;
  bgClass: string;
};

type TranslatorOption = {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  requiresKey: boolean;
};

const THEME_OPTIONS: ThemeOption[] = [
  { id: 'blue', name: 'Ocean Blue', color: '#60A5FA', bgClass: 'bg-blue-400' },
  { id: 'purple', name: 'Royal Purple', color: '#A78BFA', bgClass: 'bg-purple-400' },
  { id: 'green', name: 'Forest Green', color: '#4ADE80', bgClass: 'bg-green-400' },
  { id: 'orange', name: 'Sunset Orange', color: '#FB923C', bgClass: 'bg-orange-400' },
  { id: 'pink', name: 'Cherry Pink', color: '#F472B6', bgClass: 'bg-pink-400' },
  { id: 'red', name: 'Ruby Red', color: '#F87171', bgClass: 'bg-red-400' },
];

const TRANSLATOR_OPTIONS: TranslatorOption[] = [
  {
    id: 'groq',
    name: 'Groq',
    description: 'Fast AI-powered translation with natural language understanding. Recommended for best quality.',
    icon: (
      <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" strokeWidth="2" stroke="currentColor" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    requiresKey: true,
  },
  {
    id: 'google',
    name: 'Google Translate',
    description: 'Free translation service. Good for basic translations without API key.',
    icon: (
      <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
      </svg>
    ),
    requiresKey: false,
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Advanced AI translation using Google\'s Gemini model. Requires API key.',
    icon: (
      <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
      </svg>
    ),
    requiresKey: true,
  },
];

const Onboarding: React.FC<OnboardingProps> = ({ config, setConfig, onComplete }) => {
  const [step, setStep] = useState<number>(0);
  const [selectedTheme, setSelectedTheme] = useState<string>(config.theme_color);
  const [selectedTranslator, setSelectedTranslator] = useState<string>('groq');
  const [isCompleting, setIsCompleting] = useState<boolean>(false);

  // Get the current theme color
  const currentThemeColor = THEME_OPTIONS.find(t => t.id === selectedTheme)?.color || '#60A5FA';

  const handleThemeSelect = (themeId: string) => {
    setSelectedTheme(themeId);
  };

  const handleTranslatorSelect = (translatorId: string) => {
    setSelectedTranslator(translatorId);
  };

  const handleNext = () => {
    if (step < 1) {
      setStep(step + 1);
    }
  };

  const handleBack = () => {
    if (step > 0) {
      setStep(step - 1);
    }
  };

  const handleComplete = async () => {
    setIsCompleting(true);
    try {
      const updatedConfig: Config = {
        ...config,
        theme_color: selectedTheme,
        translator: selectedTranslator,
        onboarding_completed: true,
      };
      
      await saveConfig(updatedConfig);
      setConfig(updatedConfig);
      info('[ONBOARDING] Setup completed successfully');
      onComplete();
    } catch (err) {
      console.error('Error saving onboarding config:', err);
    } finally {
      setIsCompleting(false);
    }
  };

  const renderStepIndicator = () => (
    <div className="flex items-center justify-center space-x-2 mb-4">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="w-2 h-2 rounded-full transition-all duration-300"
          style={{
            backgroundColor: i === step 
              ? currentThemeColor 
              : i < step 
              ? `${currentThemeColor}90` 
              : 'rgba(255,255,255,0.2)',
            transform: i === step ? 'scale(1.25)' : 'scale(1)'
          }}
        />
      ))}
    </div>
  );

  const renderThemeStep = () => (
    <div className="animate-fade-in">
      <h2 className="text-lg font-bold text-white text-center mb-1">
        Choose Your Theme
      </h2>
      <p className="text-white/60 text-center text-sm mb-4">
        Select a color theme that matches your style
      </p>

      <div className="grid grid-cols-3 gap-2 mb-4">
        {THEME_OPTIONS.map((theme) => (
          <button
            key={theme.id}
            onClick={() => handleThemeSelect(theme.id)}
            className={`relative p-2 rounded-xl border-2 transition-all duration-300 group ${
              selectedTheme === theme.id
                ? 'border-white bg-white/10 scale-105'
                : 'border-white/10 bg-white/5 hover:border-white/30 hover:bg-white/10'
            }`}
          >
            <div
              className={`w-10 h-10 rounded-lg mx-auto mb-1.5 ${theme.bgClass} transition-transform duration-300 group-hover:scale-110`}
              style={{ boxShadow: `0 4px 15px ${theme.color}40` }}
            />
            <p className="text-white font-medium text-xs">{theme.name}</p>
            
            {selectedTheme === theme.id && (
              <div className="absolute top-1 right-1 w-5 h-5 bg-white rounded-full flex items-center justify-center">
                <svg className="w-3 h-3 text-dark-900" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
                </svg>
              </div>
            )}
          </button>
        ))}
      </div>

      <button
        onClick={handleNext}
        className="w-full py-2.5 rounded-xl font-semibold text-dark-900 transition-all duration-300 hover:scale-[1.02]"
        style={{ 
          backgroundColor: THEME_OPTIONS.find(t => t.id === selectedTheme)?.color || '#60A5FA',
          boxShadow: `0 4px 15px ${THEME_OPTIONS.find(t => t.id === selectedTheme)?.color}40`
        }}
      >
        Continue
      </button>
    </div>
  );

  const renderTranslatorStep = () => (
    <div className="animate-fade-in">
      <h2 className="text-lg font-bold text-white text-center mb-1">
        Select Translation Service
      </h2>
      <p className="text-white/60 text-center text-sm mb-3">
        Choose how you want your voice to be translated
      </p>

      <div className="space-y-2 mb-4">
        {TRANSLATOR_OPTIONS.map((translator) => (
          <button
            key={translator.id}
            onClick={() => handleTranslatorSelect(translator.id)}
            className="relative w-full p-2.5 rounded-xl border-2 transition-all duration-300 text-left"
            style={{
              borderColor: selectedTranslator === translator.id ? currentThemeColor : 'rgba(255,255,255,0.1)',
              backgroundColor: selectedTranslator === translator.id ? `${currentThemeColor}15` : 'rgba(255,255,255,0.05)'
            }}
          >
            <div className="flex items-center space-x-3">
              <div 
                className="p-2 rounded-lg"
                style={{
                  backgroundColor: selectedTranslator === translator.id ? `${currentThemeColor}30` : 'rgba(255,255,255,0.1)',
                  color: selectedTranslator === translator.id ? currentThemeColor : 'rgba(255,255,255,0.6)'
                }}
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  {translator.id === 'groq' && <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" strokeWidth="2" stroke="currentColor" fill="none" strokeLinecap="round" strokeLinejoin="round"/>}
                  {translator.id === 'google' && <path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>}
                  {translator.id === 'gemini' && <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>}
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center space-x-2">
                  <h3 className="text-sm font-semibold text-white">{translator.name}</h3>
                  {translator.id === 'groq' && (
                    <span 
                      className="px-1.5 py-0.5 text-[10px] font-medium rounded-full"
                      style={{ backgroundColor: `${currentThemeColor}30`, color: currentThemeColor }}
                    >
                      Recommended
                    </span>
                  )}
                </div>
                <p className="text-white/50 text-xs truncate">{translator.description.split('.')[0]}</p>
              </div>
              {selectedTranslator === translator.id && (
                <div 
                  className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ backgroundColor: currentThemeColor }}
                >
                  <svg className="w-3 h-3 text-dark-900" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              )}
            </div>
          </button>
        ))}
      </div>

      <div className="flex space-x-3">
        <button
          onClick={handleBack}
          className="flex-1 py-2.5 rounded-xl font-semibold text-white bg-white/10 border border-white/20 transition-all duration-300 hover:bg-white/20"
        >
          Back
        </button>
        <button
          onClick={handleComplete}
          disabled={isCompleting}
          className="flex-1 py-2.5 rounded-xl font-semibold text-dark-900 transition-all duration-300 hover:scale-[1.02] disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ backgroundColor: currentThemeColor }}
        >
          {isCompleting ? (
            <span className="flex items-center justify-center">
              <svg className="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Setting up...
            </span>
          ) : (
            'Get Started'
          )}
        </button>
      </div>
    </div>
  );

  return (
    <div className={`min-h-screen flex flex-col items-center justify-center relative overflow-hidden theme-${selectedTheme}`}>
      {/* Animated Background */}
      <div className="absolute inset-0 bg-gradient-to-br from-dark-900 via-dark-800 to-dark-700">
        <div className="absolute inset-0 opacity-20" style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.05'%3E%3Ccircle cx='30' cy='30' r='2'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`
        }} />

        {/* Floating Orbs - using inline styles for dynamic theme color */}
        <div 
          className="absolute top-1/4 left-1/4 w-64 h-64 rounded-full blur-3xl animate-float" 
          style={{ backgroundColor: `${currentThemeColor}15` }}
        />
        <div 
          className="absolute top-1/2 right-1/4 w-48 h-48 rounded-full blur-3xl animate-float animate-delay-300" 
          style={{ backgroundColor: `${currentThemeColor}20` }}
        />
        <div 
          className="absolute bottom-1/4 left-1/2 w-32 h-32 rounded-full blur-3xl animate-float animate-delay-500" 
          style={{ backgroundColor: `${currentThemeColor}10` }}
        />
      </div>

      {/* Content */}
      <div className="relative z-10 w-full max-w-md mx-auto px-4 py-4">
        {/* Logo */}
        <div className="flex justify-center mb-3 animate-slide-down">
          <div className="relative">
            <div 
              className="w-14 h-14 rounded-xl backdrop-blur-sm flex items-center justify-center"
              style={{ backgroundColor: `${currentThemeColor}30` }}
            >
              <img src={logo} alt="VRCTalk Logo" className="w-9 h-9 object-contain" />
            </div>
          </div>
        </div>

        {/* Welcome Title */}
        <div className="text-center mb-3 animate-slide-up">
          <h1 className="text-2xl font-bold text-white mb-1">
            Welcome to VRC<span style={{ color: currentThemeColor }}>Talk</span>
          </h1>
          <p className="text-white/60 text-sm">Let's set up your experience</p>
        </div>

        {/* Step Indicator */}
        {renderStepIndicator()}

        {/* Card */}
        <div className="modern-card p-4">
          {step === 0 && renderThemeStep()}
          {step === 1 && renderTranslatorStep()}
        </div>

        {/* Skip Option */}
        <div className="text-center mt-3">
          <button
            onClick={handleComplete}
            className="text-white/40 text-xs hover:text-white/60 transition-colors duration-300"
          >
            Skip setup and use defaults
          </button>
        </div>
      </div>
    </div>
  );
};

export default Onboarding;
