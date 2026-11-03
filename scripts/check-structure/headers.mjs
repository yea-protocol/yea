/**
 * Whether a file opens with its header (CONTRIBUTING.md#code-organization):
 * a doc comment in TS and JS that isn't a declaration's JSDoc, the same at
 * the top of a Vue file's script block, and a module docstring in Python.
 */

const DECLARATION =
  /^(export|function|async|const|let|var|class|interface|type|enum|abstract|declare)\b/;
const DOCSTRING = /^[rRuU]?("""|''')/;
const PY_PREAMBLE = /^(#.*|\s*)$/;

/**
 * True when TS/JS source opens (after any shebang) with a `/**` comment that
 * isn't directly above a declaration.
 */
export function scriptHeader(text) {
  const body = text.replace(/^#!.*\n/, '').trimStart();
  const end = body.indexOf('*/');

  if (!body.startsWith('/**') || end < 0) {
    return false;
  }

  const [rest, next = ''] = body.slice(end + 2).split('\n');
  const following = rest.trim() === '' ? next : rest.trim();

  return !DECLARATION.test(following);
}

/** True when a Vue file's first `<script>` opens with a file header. */
export function vueHeader(text) {
  const script = /<script\b[^>]*>/i.exec(text);

  return (
    script !== null && scriptHeader(text.slice(script.index + script[0].length))
  );
}

/** True when a module's first statement is its docstring. */
export function pythonHeader(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => !PY_PREAMBLE.test(line));

  return start >= 0 && DOCSTRING.test(lines[start]);
}
