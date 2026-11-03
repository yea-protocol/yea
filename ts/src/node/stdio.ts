/** The stdio transport: a service started as a child process, one JSON frame per line each way. */
import { spawn } from 'node:child_process';
import { lines, type Transport } from '../client.js';

/** Start the service `command` (split on spaces) and talk to it over its stdin and stdout. */
export function stdioTransport(command: string): Transport {
  const [cmd, ...args] = command.trim().split(/\s+/);
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const t = lines(
    (s) => child.stdin.write(s),
    () => {
      child.kill();
      // And let go of it: a service that ignores SIGTERM can't keep this process running.
      child.stdin.destroy();
      child.stdout.destroy();
      child.unref();
    },
  );

  child.on('error', (e) => t.fail(e));
  child.stdin.on('error', () => {
    // EPIPE after the child exits; the 'exit' handler already failed the transport
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c: string) => t.feed(c));
  child.on('exit', () => t.fail(new Error('service process exited')));

  return t;
}
