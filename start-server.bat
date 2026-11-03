@echo off
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установи его с https://nodejs.org и запусти этот файл снова.
  pause
  exit /b 1
)
cd /d "%~dp0"
if not exist .env (
  echo Файл .env не найден: сайт будет работать только через OpenDota.
  echo Скопируй .env.example в .env и впиши ключи.
)
start "" "http://localhost:3000"
node server.js
pause
