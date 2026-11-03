/**
 * `yea doctor`'s lines: ✓ fine, ! worth knowing, and ✗ for what stops an AI tool starting YEA,
 * which makes doctor exit 1.
 */
import { printable } from '../../text.js';

/** A line's mark. */
export type Mark = '✓' | '!' | '✗';

/** Prints doctor's lines, and remembers whether any was ✗. */
export class Report {
  failed = false;

  ok(text: string) {
    this.line('✓', text);
  }

  warn(text: string) {
    this.line('!', text);
  }

  bad(text: string) {
    this.line('✗', text);
  }

  /** Print `text` after `mark`, each of its lines escaped: it can quote config files and stderr. */
  line(mark: Mark, text: string) {
    this.failed ||= mark === '✗';
    console.log(`${mark} ${text.split('\n').map(printable).join('\n')}`);
  }
}
