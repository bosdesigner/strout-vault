// Usage: npm run hash-password            (prompts, input hidden)
//        npm run hash-password -- 'secret' (non-interactive)
import readline from "node:readline";
import { hashPassword } from "../server/auth/password.ts";

async function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const stdout = process.stdout as NodeJS.WriteStream & { muted?: boolean };
    const write = stdout.write.bind(stdout);
    process.stdout.write(prompt);
    let muted = false;
    (stdout as unknown as { write: typeof write }).write = ((chunk: unknown, ...rest: unknown[]) => {
      if (muted) return true;
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof write;
    muted = true;
    rl.question("", (answer) => {
      muted = false;
      (stdout as unknown as { write: typeof write }).write = write;
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

const arg = process.argv[2];
const password = arg ?? (await readHidden("Password: "));
if (!password || password.length < 8) {
  console.error("Use a password of at least 8 characters.");
  process.exit(1);
}
const hash = await hashPassword(password);
console.log("\nADMIN_PASSWORD_HASH=" + hash);
console.log("\nPut that line in .env (locally) or in Replit Secrets as ADMIN_PASSWORD_HASH.");
