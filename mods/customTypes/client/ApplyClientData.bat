@echo off
setlocal
set "PY=%CUSTOMTYPES_PYTHON%"
if "%PY%"=="" set "PY=%~dp0..\..\..\tools\.elysian-suite\venv\Scripts\python.exe"
if not exist "%PY%" (
  echo Python 3.11+ with Pillow not found: %PY%
  echo Set CUSTOMTYPES_PYTHON, or start tools\Launch-Elysian-Tools.bat once to create that venv.
  exit /b 1
)
"%PY%" -B "%~dp0apply_client_data.py" %*
exit /b %errorlevel%
