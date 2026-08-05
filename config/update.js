// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
const path = require('path');
const { execSync } = require('child_process');
const { deleteNodeModules } = require('./helpers');

const config = {
  bun: process.argv.includes('-b'),
  local: process.argv.includes('-l'),
  skipGit: process.argv.includes('-g'),
};

// Set the directories
const rootDir = path.resolve(__dirname, '..');
const directories = [
  rootDir,
  path.resolve(rootDir, 'packages', 'data-provider'),
  path.resolve(rootDir, 'packages', 'data-schemas'),
  path.resolve(rootDir, 'packages', 'client'),
  path.resolve(rootDir, 'packages', 'api'),
  path.resolve(rootDir, 'client'),
  path.resolve(rootDir, 'api'),
];

(async () => {
  console.green(
    'Starting update script, this may take a minute or two depending on your system and network.',
  );

  const { skipGit, bun } = config;
  if (!skipGit) {
    // Fetch latest repo
    console.purple('Fetching the latest repo...');
    execSync('git fetch origin', { stdio: 'inherit' });

    // Switch to main branch
    console.purple('Switching to main branch...');
    execSync('git checkout main', { stdio: 'inherit' });

    // Git pull origin main
    console.purple('Pulling the latest code from main...');
    execSync('git pull origin main', { stdio: 'inherit' });
  }

  // Delete all node_modules
  directories.forEach(deleteNodeModules);

  // Run npm cache clean --force
  console.purple('Cleaning npm cache...');
  execSync('npm cache clean --force', { stdio: 'inherit' });

  // Install dependencies
  console.purple('Installing dependencies...');
  execSync('npm ci', { stdio: 'inherit' });

  // Build client-side code
  console.purple('Building frontend...');
  execSync(bun ? 'bun b:client' : 'npm run frontend', { stdio: 'inherit' });

  const startCommand = 'npm run backend';
  console.green('Your LibreChat app is now up to date! Start the app with the following command:');
  console.purple(startCommand);
  console.orange(
    "Note: it's also recommended to clear your browser cookies and localStorage for LibreChat to assure a fully clean installation.",
  );
  console.orange("Also: Don't worry, your data is safe :)");
})();
