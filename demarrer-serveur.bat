@echo off
rem Demarre le serveur de lecture sur ce PC : modele de vision (Ollama) + serveur + tunnel HTTPS (Tailscale Funnel).
rem Lance automatiquement a l'ouverture de Windows (raccourci dans le dossier Demarrage), ou par double-clic.
rem Laissez la fenetre ouverte (elle peut rester reduite) : la fermer arrete le serveur.
rem Reglages (code d'acces, sites autorises) : server\.env
chcp 65001 >nul
cd /d "%~dp0"
title Serveur de lecture - Tournees

where node >nul 2>nul || (echo Node.js est introuvable. Installez-le depuis https://nodejs.org puis relancez. & pause & exit /b 1)
if not exist "server\.env" (echo Le fichier server\.env est absent : copiez server\.env.example et renseignez ACCESS_CODE. & pause & exit /b 1)

rem 0. Deja lance ? On ne demarre pas un second serveur sur le meme port.
curl -s -m 3 -o nul http://localhost:8787/health
if not errorlevel 1 (
  echo Le serveur de lecture tourne deja. Cette fenetre se ferme.
  timeout /t 5 >nul
  exit /b 0
)

rem 1. Modele de vision : Ollama demarre seul avec Windows. A l'ouverture de session il peut mettre un moment :
rem    on l'attend jusqu'a une minute, et on ne le lance nous-memes que s'il ne vient pas.
set /a essais=0
:attendre_ollama
curl -s -m 3 -o nul http://localhost:11434/api/tags
if not errorlevel 1 goto ollama_ok
set /a essais+=1
if %essais% geq 12 (
  echo Demarrage d'Ollama...
  start "" /min "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve
  timeout /t 5 /nobreak >nul
  goto ollama_ok
)
echo Attente d'Ollama...
timeout /t 5 /nobreak >nul
goto attendre_ollama
:ollama_ok

rem 2. Tunnel HTTPS : rend le port 8787 joignable depuis internet (adresse fixe en .ts.net).
if exist "%ProgramFiles%\Tailscale\tailscale.exe" (
  "%ProgramFiles%\Tailscale\tailscale.exe" funnel --bg --yes 8787 >nul 2>nul
  echo Adresse a saisir dans les reglages de l'application :
  "%ProgramFiles%\Tailscale\tailscale.exe" funnel status 2>nul | findstr /i "https://"
) else (
  echo Tailscale n'est pas installe : le serveur ne sera joignable que depuis ce PC.
)
echo.

rem 3. Serveur de lecture. S'il s'arrete (erreur), il est relance au bout de 10 secondes.
:lancer
node server\index.mjs
echo.
echo Le serveur s'est arrete. Relance dans 10 secondes (fermez cette fenetre pour l'arreter).
timeout /t 10 >nul
goto lancer
