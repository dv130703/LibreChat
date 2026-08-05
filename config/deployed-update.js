const { execSync } = require('child_process');

function getCurrentBranch() {
  return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
}

const shouldRebase = process.argv.includes('--rebase');

(async () => {
  console.green(
    'Starting deployed update script, this may take a minute or two depending on your system and network.',
  );

  console.purple('Fetching the latest repo...');
  execSync('git fetch origin', { stdio: 'inherit' });

  if (!shouldRebase) {
    execSync('git checkout main', { stdio: 'inherit' });
    console.purple('Pulling the latest code from main...');
    execSync('git pull origin main', { stdio: 'inherit' });
  } else {
    const currentBranch = getCurrentBranch();
    console.purple(`Rebasing ${currentBranch} onto main...`);
    execSync('git rebase origin/main', { stdio: 'inherit' });
  }

  const startCommand = 'npm run backend';
  console.green('Your LibreChat app is now up to date! Start the app with the following command:');
  console.purple(startCommand);
  console.orange(
    "Note: it's also recommended to clear your browser cookies and localStorage for LibreChat to assure a fully clean installation.",
  );
  console.orange("Also: Don't worry, your data is safe :)");
})().catch((err) => {
  console.error('Update script failed:', err.message);
  process.exit(1);
});
