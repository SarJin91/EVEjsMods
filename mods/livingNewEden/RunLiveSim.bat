@echo off
setlocal
node --disable-warning=ExperimentalWarning --require "%~dp0tools\liveSim\sqliteShim\preload.js" "%~dp0tools\liveSim.js" %*
exit /b %ERRORLEVEL%
