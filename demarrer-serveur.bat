@echo off
rem Demarre le serveur de lecture sur ce PC : modele de vision (Ollama) + serveur + tunnel HTTPS (Tailscale Funnel).
rem Double-cliquez sur ce fichier. Laissez la fenetre ouverte : la fermer arrete le serveur.
rem Reglages (code d'acces, sites autorises) : server\.env
chcp 65001 >nul
cd /d "%~dp0"
title Serveur de lecture - Tournees

where node >nul 2>nul || (echo Node.js est introuvable. Installez-le depuis https://nodejs.org puis relancez. & pause & exit /b 1)
if not exist "server\.env" (echo Le fichier server\.env est absent : copiez server\.env.example et renseignez ACCESS_CODE. & pause & exit /b 1)

rem 1. Modele de vision : Ollama demarre seul avec Windows ; on le lance s'il ne repond pas.
curl -s -o nul http://localhost:11434/api/tags
if errorlevel 1 (
  echo Demarrage d'Ollama...
  start "" /min "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve
  timeout /t 5 /nobreak >nul
)

rem 2. Tunnel HTTPS : rend le port 8787 joignable depuis internet (adresse fixe en .ts.net).
if exist "%ProgramFiles%\Tailscale\tailscale.exe" (
  "%ProgramFiles%\Tailscale\tailscale.exe" funnel --bg --yes 8787 >nul 2>nul
  echo Adresse a saisir dans les reglages de l'application :
  "%ProgramFiles%\Tailscale\tailscale.exe" funnel status 2>nul | findstr /i "https://"
) else (
  echo Tailscale n'est pas installe : le serveur ne sera joignable que depuis ce PC.
)
echo.

rem 3. Serveur de lecture (Ctrl+C pour arreter).
node server\index.mjs
echo.
echo Le serveur s'est arrete.
pause
