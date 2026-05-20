@echo off
for /f "delims=" %%f in ('dir /b /a-d /on') do echo %%~nf
pause