# VRCTalk Dependency Update Script (PowerShell)
# Windows-compatible version

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "VRCTalk Dependency Update Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "📦 Phase 1: Critical Updates (Speech Recognition & Tauri)" -ForegroundColor Yellow
Write-Host "These are safe and should fix the Web Speech API issues" -ForegroundColor White
Write-Host ""

$phase1 = Read-Host "Continue with Phase 1? (y/n)"
if ($phase1 -eq "y" -or $phase1 -eq "Y") {
    Write-Host "Updating Web Speech API types..." -ForegroundColor Green
    npm install --save @types/dom-speech-recognition@latest
    
    Write-Host "Updating Tauri core..." -ForegroundColor Green
    npm install @tauri-apps/api@latest @tauri-apps/cli@latest
    
    Write-Host "Updating Tauri plugins..." -ForegroundColor Green
    npm install @tauri-apps/plugin-fs@latest @tauri-apps/plugin-log@latest
    npm install @tauri-apps/plugin-opener@latest @tauri-apps/plugin-shell@latest
    
    Write-Host "✅ Phase 1 complete!" -ForegroundColor Green
}

Write-Host ""
Write-Host "📦 Phase 2: Build Tools (Low Risk)" -ForegroundColor Yellow
Write-Host "Updating build tools and CSS processors" -ForegroundColor White
Write-Host ""

$phase2 = Read-Host "Continue with Phase 2? (y/n)"
if ($phase2 -eq "y" -or $phase2 -eq "Y") {
    Write-Host "Updating build tools..." -ForegroundColor Green
    npm install autoprefixer@latest postcss@latest
    npm install @types/node@20.19.43  # Stay on v20 LTS
    
    Write-Host "✅ Phase 2 complete!" -ForegroundColor Green
}

Write-Host ""
Write-Host "⚠️  Phase 3: Major Version Updates (BREAKING CHANGES)" -ForegroundColor Red
Write-Host "These require code changes and testing:" -ForegroundColor White
Write-Host "  - React 18 → 19" -ForegroundColor White
Write-Host "  - TypeScript 5 → 7" -ForegroundColor White
Write-Host "  - Vite 6 → 8" -ForegroundColor White
Write-Host "  - Tailwind 3 → 4" -ForegroundColor White
Write-Host ""
Write-Host "❌ SKIPPING Phase 3 - Manual review required" -ForegroundColor Red
Write-Host ""

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "✅ Update Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Test the application: npm run tauri dev" -ForegroundColor White
Write-Host "2. Check for TypeScript errors: npm run build" -ForegroundColor White
Write-Host "3. If Web Speech works, you're done!" -ForegroundColor White
Write-Host "4. If issues persist, check TROUBLESHOOTING.md" -ForegroundColor White
Write-Host ""
Write-Host "For major version updates (Phase 3), please:" -ForegroundColor Yellow
Write-Host "1. Review migration guides for each package" -ForegroundColor White
Write-Host "2. Update code to handle breaking changes" -ForegroundColor White
Write-Host "3. Test thoroughly before deploying" -ForegroundColor White
