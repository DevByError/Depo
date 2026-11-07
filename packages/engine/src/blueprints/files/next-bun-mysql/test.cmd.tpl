@echo off
rem Run every test and type check on Windows.
setlocal
cd /d "%~dp0be"
call bun test || exit /b 1
call bun run typecheck || exit /b 1
cd /d "%~dp0fe"
call bun test lib || exit /b 1
call bun run typecheck || exit /b 1
echo All tests passed.
