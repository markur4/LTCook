@echo off
setlocal
if not defined LOCALAPPDATA set "LOCALAPPDATA=%USERPROFILE%\AppData\Local"
set "DIRECTORY=%LOCALAPPDATA%\ltcook\installation"
call "%DIRECTORY%\uninstall.cmd" %*
exit /b %ERRORLEVEL%
