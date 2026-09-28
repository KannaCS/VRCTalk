#!/bin/bash

echo "========================================"
echo "VRCTalk Dependency Update Script"
echo "========================================"
echo ""

echo "📦 Phase 1: Critical Updates (Speech Recognition & Tauri)"
echo "These are safe and should fix the Web Speech API issues"
echo ""
read -p "Continue with Phase 1? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]
then
    echo "Updating Web Speech API types..."
    npm install --save @types/dom-speech-recognition@latest
    
    echo "Updating Tauri core..."
    npm install @tauri-apps/api@latest @tauri-apps/cli@latest
    
    echo "Updating Tauri plugins..."
    npm install @tauri-apps/plugin-fs@latest @tauri-apps/plugin-log@latest
    npm install @tauri-apps/plugin-opener@latest @tauri-apps/plugin-shell@latest
    
    echo "✅ Phase 1 complete!"
fi

echo ""
echo "📦 Phase 2: Build Tools (Low Risk)"
echo "Updating build tools and CSS processors"
echo ""
read -p "Continue with Phase 2? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]
then
    echo "Updating build tools..."
    npm install autoprefixer@latest postcss@latest
    npm install @types/node@20.19.43  # Stay on v20 LTS
    
    echo "✅ Phase 2 complete!"
fi

echo ""
echo "⚠️  Phase 3: Major Version Updates (BREAKING CHANGES)"
echo "These require code changes and testing:"
echo "  - React 18 → 19"
echo "  - TypeScript 5 → 7"
echo "  - Vite 6 → 8"
echo "  - Tailwind 3 → 4"
echo ""
echo "❌ SKIPPING Phase 3 - Manual review required"
echo ""

echo "========================================"
echo "✅ Update Complete!"
echo "========================================"
echo ""
echo "Next steps:"
echo "1. Test the application: npm run tauri dev"
echo "2. Check for TypeScript errors: npm run build"
echo "3. If Web Speech works, you're done!"
echo "4. If issues persist, check TROUBLESHOOTING.md"
echo ""
echo "For major version updates (Phase 3), please:"
echo "1. Review migration guides for each package"
echo "2. Update code to handle breaking changes"
echo "3. Test thoroughly before deploying"
