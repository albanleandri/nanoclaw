import { validateMemoryTree } from './validator.js';

const root = process.argv[2];
if (!root) {
  process.stderr.write('memory-validator: root argument required\n');
  process.exit(2);
}

process.stdout.write(`${JSON.stringify(validateMemoryTree(root))}\n`);
