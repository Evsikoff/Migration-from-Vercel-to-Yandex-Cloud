@echo off
rem Обновляет устаревшие копии без интерфейса. Подходит для Планировщика заданий Windows.
rem Параметр --all обновит и бакеты с неизвестной версией.
chcp 65001 >nul
cd /d "%~dp0"
node src\cli.js update-outdated %*
