@echo off
node "%~dp0test\run.js" || exit /b 1
set "PY=%~dp0..\..\tools\.elysian-suite\venv\Scripts\python.exe"
if exist "%PY%" "%PY%" -B "%~dp0client\test_apply_client_data.py"
