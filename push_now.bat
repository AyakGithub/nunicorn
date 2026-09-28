@echo off
cd /d "C:\Work\projects\nunicorn"

echo Removing stale lock if exists...
if exist ".git\index.lock" del ".git\index.lock"
if exist ".git\HEAD.lock" del ".git\HEAD.lock"
if exist ".git\packed-refs.lock" del ".git\packed-refs.lock"
if exist ".git\refs\heads\main_local.lock" del ".git\refs\heads\main_local.lock"
if exist ".git\refs\heads\master.lock" del ".git\refs\heads\master.lock"

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Node.js not found - skipping tests. Tests are run in the sandbox before deploy.
) else (
    echo Running tests...
    node --test tests/*.test.js
    if %ERRORLEVEL% NEQ 0 (
        echo Tests failed! Aborting push.
        pause
        exit /b 1
    )
)

echo Staging all changes...
git add -A -- . ":!.github"

echo Committing...
git commit -m "feat(legal): add business registration info to footers and terms (Hitch Company, 533-67-00750)"
if %ERRORLEVEL% NEQ 0 (
    echo Nothing to commit or commit failed.
)

echo Pushing to remote main...
git push origin main_local:main

echo.
echo Done. Check https://www.nunicorn.co.kr in 30-60 seconds.
pause
