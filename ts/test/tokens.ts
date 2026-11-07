/**
 * A small TypeScript tokenizer for the import audit (imports.ts): enough of the lexical grammar to
 * tell code from comments, strings, template literals and regular expressions, so a comment can't
 * hide an import and a string can't fake one. The repo's TypeScript 7 exposes no parser to
 * JavaScript, so this is its own. Anything it can't classify throws: the audit fails closed.
 */

/** A token: a name (identifier or keyword), a string, a template chunk, a regex, a number, or one punctuation character. */
export interface Token {
  kind: 'name' | 'string' | 'template' | 'regex' | 'number' | 'punct';
  value: string;
  /** The 1-based line it ends on. */
  line: number;
}

/** A source file the tokenizer can't classify, with the line where it stopped. */
export class TokenError extends Error {}

/** After these keywords a `/` starts a regular expression, not a division. */
const BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'extends',
  'default',
  'break',
  'continue',
]);
/** After the `)` that closes these keywords' `(`, a `/` starts a regular expression: `if (a) /re/`. */
const HEADS = new Set(['if', 'while', 'for', 'with']);
const PUNCT = new Set('{}()[];,.<>+-*%&|^!~?:=@#');
const NAME_START = /[\p{ID_Start}$_]/u;
const NAME_PART = /[\p{ID_Continue}$‌‍]/u;

/** Tokenize `text`; throws `TokenError` on anything it can't classify. */
export function tokenize(text: string): Token[] {
  const lexer = new Lexer(text);

  lexer.code(false);

  return lexer.tokens;
}

/** What a `/` is: a regular expression, division, or either as far as the tokens before it say. */
type Slash = 'regex' | 'division' | 'unsure';

/** The lexer's state: where it is, what it has read, and the line count. */
class Lexer {
  tokens: Token[] = [];
  private i = 0;
  /** For each open `(`, what a `/` after its `)` is: `if (a) /re/`, but `f(a) / 2`. */
  private readonly parens: Slash[] = [];
  /** What a `/` after the last `)` is. */
  private afterParen: Slash = 'division';
  /** Where each line after the first starts, for line numbers. */
  private readonly breaks: number[] = [];

  constructor(private readonly text: string) {
    for (
      let at = text.indexOf('\n');
      at >= 0;
      at = text.indexOf('\n', at + 1)
    ) {
      this.breaks.push(at);
    }

    if (text.startsWith('#!')) {
      this.skipLine();
    }
  }

  /** Read code up to the end, or, inside a template's `${…}`, up to its closing brace. */
  code(inTemplate: boolean) {
    let depth = 0;

    while (this.i < this.text.length) {
      const c = this.text[this.i];

      if (c === '}' && inTemplate && depth === 0) {
        this.i++;

        return;
      }

      depth += c === '{' ? 1 : c === '}' ? -1 : 0;
      this.next(c);
    }

    if (inTemplate) {
      this.fail('a template literal is not closed');
    }
  }

  /** Read the one token, comment or space that starts with `c`. */
  private next(c: string) {
    const two = this.text.slice(this.i, this.i + 2);

    if (/\s/.test(c)) {
      this.i++;
    } else if (two === '//') {
      this.skipLine();
    } else if (two === '/*') {
      this.skipBlockComment();
    } else if (c === "'" || c === '"') {
      this.push('string', this.quoted(c));
    } else if (c === '`') {
      this.template();
    } else if (
      NAME_START.test(c) ||
      (c === '#' && NAME_START.test(this.text[this.i + 1] ?? ''))
    ) {
      this.push('name', this.run(1, NAME_PART));
    } else if (
      /[0-9]/.test(c) ||
      (c === '.' && /[0-9]/.test(this.text[this.i + 1] ?? ''))
    ) {
      this.push('number', this.run(1, /[\w.]/));
    } else if (c === '/') {
      this.slash();
    } else if (PUNCT.has(c)) {
      this.paren(c);
      this.i++;
      this.push('punct', c);
    } else {
      this.fail(`unexpected character U+${c.codePointAt(0)?.toString(16)}`);
    }
  }

  /**
   * A `/` that isn't a comment: a regular expression or division, as `slashKind` says. Where it's
   * unsure, the `/` divides only if no regular expression could close on its line; else this throws.
   */
  private slash() {
    const kind = this.slashKind();
    const end = kind === 'division' ? undefined : this.regexEnd();

    if (end === undefined) {
      if (kind === 'regex') {
        this.fail('a regular expression is not closed');
      }

      this.i++;
      this.push('punct', '/');

      return;
    }

    if (kind === 'unsure') {
      this.fail('a / here could divide or start a regular expression');
    }

    const start = this.i;

    this.i = end;
    this.run(0, /[a-z]/);
    this.push('regex', this.text.slice(start, this.i));
  }

  /**
   * What a `/` here is, by the token before it. After a value on an earlier line it's unsure, as a
   * type can end a declaration there (`let a: T`, then `/re/.test(b)` on the next line).
   */
  private slashKind(): Slash {
    const prev = this.tokens.at(-1);

    if (prev === undefined) {
      return 'regex';
    }

    const kind = this.slashAfter(prev);

    return kind === 'division' && prev.line < this.lineAt(this.i)
      ? 'unsure'
      : kind;
  }

  /**
   * What a `/` after `prev` is: a regular expression after an operator, a keyword like `return` or
   * `if (…)`, and division after a value. It's unsure after `}`, `++`, `--`, `of` (also a name)
   * and a template, which can each come before either.
   */
  private slashAfter(prev: Token): Slash {
    const name = this.lastName();

    if (prev.kind === 'punct') {
      const before = this.tokens.at(-2);
      const doubled =
        (prev.value === '+' || prev.value === '-') &&
        before?.kind === 'punct' &&
        before.value === prev.value;

      if (prev.value === ')') {
        return this.afterParen;
      }

      return prev.value === ']'
        ? 'division'
        : prev.value === '}' || doubled
          ? 'unsure'
          : 'regex';
    }

    if (prev.kind === 'template' || name === 'of') {
      return 'unsure';
    }

    return name !== undefined && BEFORE_REGEX.has(name) ? 'regex' : 'division';
  }

  /** Track each `(` and `)`, for what a `/` after the `)` is. */
  private paren(c: string) {
    if (c === '(') {
      const name = this.lastName() ?? '';

      this.parens.push(
        HEADS.has(name) ? 'regex' : name === 'await' ? 'unsure' : 'division',
      );
    } else if (c === ')') {
      this.afterParen = this.parens.pop() ?? this.fail('a ) closes no (');
    }
  }

  /** The last token if it's a name and not a property (`a.in`), else undefined. */
  private lastName(): string | undefined {
    const [before, prev] = [this.tokens.at(-2), this.tokens.at(-1)];
    const property = before?.kind === 'punct' && before.value === '.';

    return prev?.kind === 'name' && !property ? prev.value : undefined;
  }

  /** The index after the `/` that would close a regular expression opening here, or undefined if none closes on this line. */
  private regexEnd(): number | undefined {
    let inClass = false;

    for (let i = this.i + 1; i < this.text.length; i++) {
      const c = this.text[i];

      if (c === '\n' || (c === '\\' && this.text[i + 1] === '\n')) {
        return undefined;
      }

      if (c === '\\') {
        i++;
      } else if (c === '[') {
        inClass = true;
      } else if (c === ']') {
        inClass = false;
      } else if (c === '/' && !inClass) {
        return i + 1;
      }
    }

    return undefined;
  }

  /** A quoted string's contents; the quote at `this.i` opens it. */
  private quoted(quote: string): string {
    const start = ++this.i;

    for (; this.i < this.text.length; this.i++) {
      const c = this.text[this.i];

      if (c === '\\') {
        this.i++;
      } else if (c === quote) {
        return this.text.slice(start, this.i++);
      } else if (c === '\n') {
        break;
      }
    }

    this.fail('a string is not closed');
  }

  /** A template literal: its text chunks as tokens, and its `${…}` expressions as code. */
  private template() {
    let start = ++this.i;

    for (; this.i < this.text.length; this.i++) {
      const c = this.text[this.i];

      if (c === '\\') {
        this.i++;
      } else if (c === '`') {
        this.push('template', this.text.slice(start, this.i++));

        return;
      } else if (c === '$' && this.text[this.i + 1] === '{') {
        this.push('template', this.text.slice(start, this.i));
        this.i += 2;
        this.code(true);
        start = this.i--;
      }
    }

    this.fail('a template literal is not closed');
  }

  /** Skip to the end of the line. */
  private skipLine() {
    const end = this.text.indexOf('\n', this.i);

    this.i = end < 0 ? this.text.length : end;
  }

  /** Skip a `/* … *\/` comment. */
  private skipBlockComment() {
    const end = this.text.indexOf('*/', this.i + 2);

    if (end < 0) {
      this.fail('a comment is not closed');
    }

    this.i = end + 2;
  }

  /** Read the characters matching `part`, after the first `skip` ones, and return them all. */
  private run(skip: number, part: RegExp): string {
    const start = this.i;

    this.i += skip;

    while (this.i < this.text.length && part.test(this.text[this.i])) {
      this.i++;
    }

    return this.text.slice(start, this.i);
  }

  private push(kind: Token['kind'], value: string) {
    this.tokens.push({ kind, value, line: this.lineAt(this.i) });
  }

  /** The 1-based line of index `i`: one more than the line breaks before it. */
  private lineAt(i: number) {
    let [lo, hi] = [0, this.breaks.length];

    while (lo < hi) {
      const mid = (lo + hi) >> 1;

      if (this.breaks[mid] < i) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    return lo + 1;
  }

  private fail(why: string): never {
    throw new TokenError(`line ${this.lineAt(this.i)}: ${why}`);
  }
}
