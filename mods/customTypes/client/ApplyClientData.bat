@echo off
setlocal
set "PY=%~dp0..\..\..\tools\.elysian-suite\venv\Scripts\python.exe"
if not exist "%PY%" (
  echo Elysian suite venv not found: %PY%
  echo Start tools\Launch-Elysian-Tools.bat once to create it.
  exit /b 1
)
"%PY%" -B "%~dp0apply_client_data.py" %*
exit /b %errorlevel%
