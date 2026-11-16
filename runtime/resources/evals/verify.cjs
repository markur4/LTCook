// Verify the predefined scenario fixture inside its disposable workspace.
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync('.ltcook-evals/input.json', 'utf8'));
const answer = JSON.parse(fs.readFileSync('.ltcook-evals/answer.json', 'utf8'));
if (answer.total !== input.prices.reduce((sum, value) => sum + value, 0) - input.discount) process.exit(1);
console.log('LTCook fixture verification passed');
