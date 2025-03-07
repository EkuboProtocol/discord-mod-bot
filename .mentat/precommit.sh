#!/bin/bash

# Check if package.json exists (Node.js project)
if [ -f "package.json" ]; then
  echo "Node.js project detected. Running precommit checks..."
  
  # Run format if script exists
  if grep -q "\"format\"" "package.json"; then
    npm run format
  fi
  
  # Run lint if script exists
  if grep -q "\"lint\"" "package.json"; then
    npm run lint
  fi
  
  # Run type check if script exists
  if grep -q "\"typecheck\"" "package.json"; then
    npm run typecheck
  fi
  
  # Only run tests if they're not run in CI
  if [ ! -f ".github/workflows/ci.yml" ] || ! grep -q "npm.*test" ".github/workflows/ci.yml"; then
    if grep -q "\"test\"" "package.json"; then
      npm run test
    fi
  fi
  
  exit 0
fi

# Check if it's a Python project
if [ -f "requirements.txt" ] || [ -d ".venv" ]; then
  echo "Python project detected. Running precommit checks..."
  
  # Activate virtual environment if it exists
  if [ -d ".venv" ]; then
    source .venv/bin/activate
  fi
  
  # Run black formatter if installed
  if command -v black &> /dev/null; then
    black .
  fi
  
  # Run flake8 linter if installed
  if command -v flake8 &> /dev/null; then
    flake8 .
  fi
  
  # Run ruff if installed
  if command -v ruff &> /dev/null; then
    ruff format .
    ruff check --fix .
  fi
  
  # Run type checker if installed
  if command -v mypy &> /dev/null; then
    mypy .
  elif command -v pyright &> /dev/null; then
    pyright
  fi
  
  # Only run tests if they're not run in CI
  if [ ! -f ".github/workflows/ci.yml" ] || ! grep -q "pytest" ".github/workflows/ci.yml"; then
    if command -v pytest &> /dev/null; then
      pytest
    fi
  fi
  
  exit 0
fi

# If we're here, we couldn't detect the project type
echo "Could not detect project type (Node.js or Python). No precommit checks run."
echo "Please modify this script according to your project needs."
echo "If this script doesn't work for your project structure, please contact the developer to increase the time limit or customize the script."
