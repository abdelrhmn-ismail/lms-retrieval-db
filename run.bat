@echo off
echo ====================================================
echo Starting LMS & TMS Database Retrieval Tool...
echo ====================================================
cd /d "%~dp0"
start http://localhost:3000
node server.js
pause
