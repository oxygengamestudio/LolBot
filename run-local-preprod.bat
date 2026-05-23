@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not available in PATH.
    exit /b 1
)
node --version >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was found but cannot run.
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm is not available in PATH.
    exit /b 1
)
call npm --version >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm was found but cannot run. Repair the local Node.js/npm installation.
    exit /b 1
)

if exist ".env.preprod.local" (
    set "BOT_ENV_FILE=%CD%\.env.preprod.local"
    echo [INFO] Using .env.preprod.local through BOT_ENV_FILE.
) else (
    echo [INFO] .env.preprod.local not found. Using the current environment and default .env loading.
)

if not exist "node_modules" (
    echo [INFO] node_modules not found. Installing dependencies with npm ci...
    call npm ci
    if errorlevel 1 exit /b 1
)

set "RUN_COMMAND="
for /f "usebackq delims=" %%C in (`node -e "const fs=require('fs'); const p=require('./package.json'); const s=p.scripts||{}; if(s.dev) console.log('npm run dev'); else if(s.start) console.log('npm start'); else if(fs.existsSync('dist/index.js')) console.log('node dist/index.js'); else if(fs.existsSync('index.js')) console.log('node index.js'); else process.exit(2);"`) do set "RUN_COMMAND=%%C"

if not defined RUN_COMMAND (
    echo [ERROR] No runnable command found in package.json or fallback entrypoints.
    exit /b 1
)

echo [INFO] Running: %RUN_COMMAND%
call %RUN_COMMAND%
