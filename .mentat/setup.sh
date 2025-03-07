#!/bin/bash

# Check if package.json exists (Node.js project)
if [ -f "package.json" ]; then
  echo "Node.js project detected. Installing dependencies..."
  npm install
  # Install dev dependencies if they're not already in package.json
  if ! grep -q "eslint" "package.json"; then
    npm install --save-dev eslint
  fi
  if ! grep -q "prettier" "package.json"; then
    npm install --save-dev prettier
  fi
  if [ -f "package-lock.json" ]; then
    npm ci
  fi
  # If there's a build script, run it
  if grep -q "\"build\"" "package.json"; then
    npm run build
  fi
  exit 0
fi

# Check if requirements.txt exists (Python project)
if [ -f "requirements.txt" ]; then
  echo "Python project detected. Installing dependencies..."
  # Create virtual environment if it doesn't exist
  if [ ! -d ".venv" ]; then
    python -m venv .venv
  fi
  
  # Activate virtual environment
  source .venv/bin/activate
  
  # Install dependencies
  pip install --upgrade pip
  pip install -r requirements.txt
  
  # Install dev dependencies if they exist
  if [ -f "dev-requirements.txt" ]; then
    pip install -r dev-requirements.txt
  else
    # Install common development tools
    pip install black flake8 pytest
  fi
  exit 0
fi

# If we're here, we couldn't detect the project type
echo "Could not detect project type (Node.js or Python). No dependencies installed."
echo "Please modify this script according to your project needs."
echo "If this script doesn't work for your project structure, please contact the developer to increase the time limit or customize the script."
