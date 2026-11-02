import { createInterface } from 'node:readline';

// For commands only a person at the mini may run. A headless agent has no terminal, so this stops it from just running them.
// It is a speed bump, not a boundary: anything running as the same user can fake a terminal.
export const hasTerminal = (proc = process) => Boolean(proc.stdin.isTTY && proc.stdout.isTTY);

// Asks once. True only for exactly the expected words. End of input (Ctrl+D) is a no.
export function typed(question, expected, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });
    rl.once('close', () => resolve(false));
    rl.question(question, (answer) => {
      resolve(answer.trim() === expected);
      rl.close();
    });
  });
}
