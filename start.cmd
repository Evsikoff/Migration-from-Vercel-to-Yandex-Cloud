@echo off
chcp 65001 >nul
title Vercel - Yandex Cloud
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
node src\server.js %*
if errorlevel 1 pause
exit /b
:nonode
echo Не найден Node.js. Установите его с https://nodejs.org (версия 18 или новее) и запустите этот файл снова.
pause
exit /b 1
