// run-all.ts — Run all test scripts for @mostajs/orm-bridge
// Author: Dr Hamid MADANI drmdh@msn.com

import { execSync } from 'child_process';

const tests = [
  'test-scripts/test-prisma-bridge.ts',
  'test-scripts/test-prisma-client.ts',
  // 'test-scripts/test-drizzle-bridge.ts',  // TODO
  // 'test-scripts/test-typeorm-bridge.ts',  // TODO
];

let total = 0;
let failed = 0;

for (const test of tests) {
  console.log(`\n\x1b[1m\x1b[35m>>> ${test} <<<\x1b[0m`);
  try {
    execSync(`npx tsx ${test}`, { stdio: 'inherit' });
    total++;
  } catch {
    total++;
    failed++;
  }
}

console.log(`\n\x1b[1m=========================\x1b[0m`);
console.log(`  Test files : ${total}`);
console.log(`  ${failed === 0 ? '\x1b[32mAll passed\x1b[0m' : '\x1b[31mFailed: ' + failed + '\x1b[0m'}`);
process.exit(failed > 0 ? 1 : 0);
