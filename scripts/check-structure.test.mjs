/**
 * Tests for check-structure.mjs: each rule (header, length, name, private),
 * what the walk skips, and the ratchet in both directions.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import {
  checkFile,
  compare,
  expand,
  findViolations,
  MAX_LINES,
  report,
} from './check-structure.mjs';

const HEADER = '/** A module. */\n\n';
const DOC = '"""A module."""\n';
const BAD = 'export {};\n';
const root = mkdtempSync(join(tmpdir(), 'check-structure-'));

after(() => rmSync(root, { recursive: true, force: true }));

/** Writes `files` ({ path: text }) under a fresh folder and returns its path. */
function fixture(name, files) {
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, name, path);

    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }

  return join(root, name);
}

/** The rules `path` breaks, given its text. */
function rules(path, text) {
  return checkFile(path, text).map((v) => v.rule);
}

/** `path: rule` for each violation under `roots` in the fixture `dir`. */
function found(dir, roots) {
  return findViolations(dir, roots).map((v) => `${v.path}: ${v.rule}`);
}

test('header: TS and JS open with a /** comment, after any shebang', () => {
  assert.deepEqual(rules('a.ts', `${HEADER}export {};\n`), []);
  assert.deepEqual(rules('a.mjs', `#!/usr/bin/env node\n${HEADER}`), []);
  assert.deepEqual(rules('a.ts', '/**\n * A module.\n */\nimport x;\n'), []);
  assert.deepEqual(rules('a.ts', '/* Not a doc comment. */\n'), ['header']);
  assert.deepEqual(rules('a.ts', '// A line comment.\n'), ['header']);
  assert.deepEqual(rules('a.js', `import 'x';\n${HEADER}`), ['header']);
});

test('header: a comment directly above a declaration is its JSDoc', () => {
  for (const decl of [
    'export function f() {}',
    'const a = 1;',
    'type T = 1;',
  ]) {
    assert.deepEqual(rules('a.ts', `/** f. */\n${decl}\n`), ['header'], decl);
    assert.deepEqual(rules('a.ts', `/** f. */ ${decl}\n`), ['header'], decl);
    assert.deepEqual(rules('a.ts', `/** A module. */\n\n${decl}\n`), [], decl);
  }
});

test('header: a Vue component opens its <script> with one', () => {
  const inScript = `<script setup lang="ts">\n${HEADER}</script>\n`;

  assert.deepEqual(rules('Page.vue', inScript), []);
  assert.deepEqual(rules('Page.vue', '<!-- A page. -->\n<template/>\n'), [
    'header',
  ]);
  assert.deepEqual(rules('Page.vue', '<script setup>\nconst a = 1;\n'), [
    'header',
  ]);
});

test('header: Python modules start with their docstring', () => {
  const preamble = '#!/usr/bin/env python\n# -*- coding: utf-8 -*-\n\n';

  assert.deepEqual(rules('a.py', DOC), []);
  assert.deepEqual(rules('a.py', `${preamble}${DOC}`), []);
  assert.deepEqual(rules('a.py', `# Licensed under Apache-2.0.\n${DOC}`), []);
  assert.deepEqual(
    rules('a.py', `from __future__ import annotations\n${DOC}`),
    ['header'],
  );
  assert.deepEqual(rules('a.py', '# A comment.\nx = 1\n'), ['header']);
  assert.deepEqual(rules('a.py', ''), ['header']);
});

test(`length: at most ${MAX_LINES} lines, except bench and vectors`, () => {
  const body = (n) => HEADER + 'x;\n'.repeat(n - 2);
  const long = body(MAX_LINES + 1);

  assert.deepEqual(rules('a.ts', body(MAX_LINES)), []);
  assert.deepEqual(rules('a.ts', long), ['length']);
  assert.deepEqual(rules('bench/run.ts', long), []);
  assert.deepEqual(rules('ts/scripts/vectors.mjs', long), []);
  assert.deepEqual(rules('ts/scripts/other.mjs', long), ['length']);
});

test('name: kebab-case TS/JS, snake_case Python, PascalCase Vue', () => {
  const vue = `<script>\n${HEADER}</script>\n`;

  for (const ok of ['serve-fetch.ts', 'b64.ts', 'index.d.ts', 'cli.mjs']) {
    assert.deepEqual(rules(ok, HEADER), [], ok);
  }

  for (const bad of ['serveFetch.ts', 'Serve.ts', 'x_y.js', 'Index.d.ts']) {
    assert.deepEqual(rules(bad, HEADER), ['name'], bad);
  }

  assert.deepEqual(rules('_json.py', DOC), []);
  assert.deepEqual(rules('Client.py', DOC), ['name']);
  assert.deepEqual(rules('PlayGround.vue', vue), []);
  assert.deepEqual(rules('playground.vue', vue), ['name']);
});

test('name: known run-together words are named', () => {
  for (const joined of ['servefetch.ts', 'keyfile.ts', 'testdrive.d.ts']) {
    assert.deepEqual(rules(joined, HEADER), ['name'], joined);
  }

  assert.deepEqual(rules('key-file.ts', HEADER), []);
});

test('the walk skips tests, dependencies, build output and other files', () => {
  const dir = fixture('walk', {
    'src/ok.ts': HEADER,
    'src/bad.ts': BAD,
    'src/bad.test.ts': BAD,
    'src/node_modules/bad.ts': BAD,
    'src/dist/bad.js': BAD,
    'src/cache/bad.ts': BAD,
    'src/style.css': 'a {}\n',
    'pkgs/one/src/bad.py': 'x = 1\n',
  });

  assert.deepEqual(found(dir, ['src', 'pkgs/*/src', 'none', 'none/*/src']), [
    'pkgs/one/src/bad.py: header',
    'src/bad.ts: header',
    'src/cache/bad.ts: header',
  ]);
});

test('the walk skips VitePress output by path, not by name', () => {
  const dir = fixture('site', {
    'site/.vitepress/config.ts': BAD,
    'site/.vitepress/cache/deps/a.js': BAD,
    'site/.vitepress/dist/a.js': BAD,
    'site/.vitepress/.temp/a.js': BAD,
    'site/.vitepress/theme/cache/a.ts': BAD,
  });

  assert.deepEqual(found(dir, ['site/.vitepress']), [
    'site/.vitepress/config.ts: header',
    'site/.vitepress/theme/cache/a.ts: header',
  ]);
});

test('roots: only one whole middle segment may be *', () => {
  for (const bad of ['*/src', 'src/*', 'a/*/b/*/c', 'a/b*/c']) {
    assert.throws(() => expand(root, bad), /unsupported root/, bad);
  }
});

test('ratchet: listed violations pass, unlisted ones fail', () => {
  const violations = [
    { path: 'a.ts', rule: 'length', detail: '301 > 300' },
    { path: 'a.ts', rule: 'name', detail: 'lowercase words joined with -' },
  ];
  const result = compare(violations, { 'a.ts': ['length'] });

  assert.deepEqual(result.fixed, []);
  assert.deepEqual(report(result), [
    'a.ts: name (lowercase words joined with -)',
  ]);
});

test('ratchet: a listed violation that no longer occurs fails', () => {
  const violations = [{ path: 'a.ts', rule: 'length', detail: '301 > 300' }];
  const result = compare(violations, { 'a.ts': ['length', 'name'] });

  assert.deepEqual(result.unlisted, []);
  assert.deepEqual(report(result), [
    'a.ts: name (no longer occurs: remove it from the ratchet)',
  ]);
});

test('ratchet: an entry for a file renamed away fails', () => {
  const dir = fixture('renamed', { 'src/serve-fetch.ts': HEADER });
  const result = compare(findViolations(dir, ['src']), {
    'src/servefetch.ts': ['name'],
  });

  assert.deepEqual(report(result), [
    'src/servefetch.ts: name (no longer occurs: remove it from the ratchet)',
  ]);
});

/** A file that imports `specs`, one statement each. */
function importing(...specs) {
  return HEADER + specs.map((s) => `import { a } from '${s}';\n`).join('');
}

/** `path: rule (detail)` for each violation under `roots` in a fixture. */
function privateFound(name, files, roots = ['src']) {
  return report(compare(findViolations(fixture(name, files), roots), {}));
}

/** The files the violations under `roots` in a fixture say were imported, in order. */
function importedFiles(name, files, roots = ['src']) {
  return privateFound(name, files, roots).map(
    (line) => /imports (\S+?),? /.exec(line)?.[1],
  );
}

test('private: a module folder is closed to files outside it', () => {
  assert.deepEqual(
    privateFound('private-sibling', {
      'src/a/x/part.ts': importing('../y/part.js'),
      'src/a/y.ts': importing('./y/part.js'),
      'src/a/y/part.ts': HEADER,
    }),
    [
      'src/a/x/part.ts: private (imports src/a/y/part.ts from inside src/a/y/; import src/a/y.ts instead)',
    ],
  );
});

test('private: the entry file and the files in the folder may import it', () => {
  assert.deepEqual(
    privateFound('private-allowed', {
      'src/y.ts': importing('./y/part.js', './y/inner.js'),
      'src/y/part.ts': importing('./inner.js', '../z.js'),
      'src/y/inner.ts': importing('./inner/deep.js'),
      'src/y/inner/deep.ts': importing('../part.js', '../../z.js'),
      'src/z.ts': importing('./y.js'),
    }),
    [],
  );
});

test('private: an entry file may not reach into a nested module', () => {
  assert.deepEqual(
    privateFound('private-nested', {
      'src/x.ts': importing('./x/inner/deep.js'),
      'src/x/inner.ts': HEADER,
      'src/x/inner/deep.ts': HEADER,
    }),
    [
      'src/x.ts: private (imports src/x/inner/deep.ts from inside src/x/inner/; import src/x/inner.ts instead)',
    ],
  );
});

test('private: an index file inside a folder is not its entry', () => {
  assert.deepEqual(
    privateFound('private-index', {
      'src/run.ts': importing('./x/part.js', './y/part.js'),
      'src/x/index.ts': importing('./part.js'),
      'src/x/part.ts': HEADER,
      'src/y.ts': HEADER,
      'src/y/index.ts': HEADER,
      'src/y/part.ts': HEADER,
    }),
    [
      'src/run.ts: private (imports src/y/part.ts from inside src/y/; import src/y.ts instead)',
    ],
  );
});

test('private: a folder with no entry file is open to all', () => {
  assert.deepEqual(
    privateFound('private-plain', {
      'src/run.ts': importing('./parts/one.js', './parts/two/x.js'),
      'src/parts/one.ts': HEADER,
      'src/parts/two/x.ts': HEADER,
    }),
    [],
  );
});

test('private: a Vue entry fronts its folder whatever its case', () => {
  const vue = (spec) =>
    `<script setup lang="ts">\n${HEADER}import A from '${spec}';\n</script>\n`;

  assert.deepEqual(
    privateFound('private-vue', {
      'src/Landing.vue': vue('./landing/Hero.vue'),
      'src/landing/Hero.vue': vue('../playground/Radio.vue'),
      'src/Playground.vue': vue('./playground/Radio.vue'),
      'src/playground/Radio.vue': vue('./Radio.vue'),
    }),
    [
      'src/landing/Hero.vue: private (imports src/playground/Radio.vue from inside src/playground/; import src/Playground.vue instead)',
    ],
  );
});

test('private: imports that leave the source root are not checked', () => {
  assert.deepEqual(
    privateFound('private-outside', {
      'src/run.ts': importing('../dist/x/part.js', '../other/y/part.js'),
      'dist/x.js': HEADER,
      'dist/x/part.js': HEADER,
    }),
    [],
  );
});

test('private: every import form is read, bare package names are not', () => {
  const text = [
    HEADER,
    "import type { A } from './x/a.js';",
    'export * from "./x/b.js";',
    "export { c } from './x/c.js';",
    "import './x/d.css';",
    "const e = await import('./x/e.js');",
    "const f = require('./x/f.cjs');",
    "import g from 'node:fs';",
    "import h from '@yea-protocol/sdk';",
  ].join('\n');
  const found = importedFiles('private-forms', {
    'src/run.ts': text,
    'src/x.ts': HEADER,
  });

  assert.deepEqual(
    found,
    ['a.js', 'b.js', 'c.js', 'd.css', 'e.js', 'f.cjs'].map((f) => `src/x/${f}`),
  );
});

test('private: imports in comments are not read', () => {
  const text = [
    HEADER,
    "// import a from './x/a.js';",
    "/* import b from './x/b.js'; */",
    '/**',
    " * Use `import { c } from './x/c.js'` for c.",
    ' */',
    "const url = 'https://example.com/*'; import d from './x/d.js';",
    "const re = /['\"]\\/\\//; import e from './x/e.js'; // f",
  ].join('\n');
  const found = importedFiles('private-comments', {
    'src/run.ts': text,
    'src/x.ts': HEADER,
  });

  assert.deepEqual(found, ['src/x/d.js', 'src/x/e.js']);
});

test('private: a Vue file is read only inside <script>', () => {
  const vue = [
    '<template>',
    "  <p>Don't import from './x/a.vue'</p>",
    '</template>',
    '<script setup lang="ts">',
    HEADER,
    "import B from './x/b.vue';",
    '</script >',
    "<p>import C from './x/c.vue'</p>",
  ].join('\n');
  const found = importedFiles('private-vue-template', {
    'src/Run.vue': vue,
    'src/x.ts': HEADER,
  });

  assert.deepEqual(found, ['src/x/b.vue']);
});

/** A Python module: its docstring, then `lines`. */
function py(...lines) {
  return DOC + lines.map((line) => `${line}\n`).join('');
}

/** The files a Python import test reads: package `app` with `x/` holding `parts`. */
function appImporting(text, parts) {
  const files = {
    'src/app/__init__.py': DOC,
    'src/app/run.py': text,
    'src/app/x/__init__.py': DOC,
  };

  for (const part of parts) {
    files[`src/app/x/${part}.py`] = DOC;
  }

  return files;
}

test("private: a Python package's modules are closed to modules outside it", () => {
  assert.deepEqual(
    privateFound('python-sibling', {
      'src/app/__init__.py': DOC,
      'src/app/run.py': py('from .pkg.part import a'),
      'src/app/pkg/__init__.py': py('from .part import a'),
      'src/app/pkg/part.py': DOC,
    }),
    [
      'src/app/run.py: private (imports src/app/pkg/part.py from inside src/app/pkg/; import src/app/pkg/__init__.py instead)',
    ],
  );
});

test('private: the __init__.py and the modules in the package may import them', () => {
  assert.deepEqual(
    privateFound('python-allowed', {
      'src/app/__init__.py': py('from .pkg import a', 'from .text import t'),
      'src/app/text.py': DOC,
      'src/app/run.py': py('from .pkg import a', 'from . import text'),
      'src/app/pkg/__init__.py': py(
        'from .part import a',
        'from . import inner',
      ),
      'src/app/pkg/part.py': py('from .inner import d', 'from .. import text'),
      'src/app/pkg/inner/__init__.py': py('from .deep import d'),
      'src/app/pkg/inner/deep.py': py(
        'from ..part import a',
        'from ...run import r',
      ),
    }),
    [],
  );
});

test('private: a subpackage is open to its package, not beyond it', () => {
  assert.deepEqual(
    privateFound('python-nested', {
      'src/app/__init__.py': DOC,
      'src/app/run.py': py('from .a.b import x'),
      'src/app/a/__init__.py': py('from .b.part import y'),
      'src/app/a/c.py': py('from .b import x'),
      'src/app/a/b/__init__.py': DOC,
      'src/app/a/b/part.py': DOC,
    }),
    [
      'src/app/a/__init__.py: private (imports src/app/a/b/part.py from inside src/app/a/b/; import src/app/a/b/__init__.py instead)',
      'src/app/run.py: private (imports src/app/a/b/__init__.py from inside src/app/a/; import src/app/a/__init__.py instead)',
    ],
  );
});

test('private: from .pkg import x names a submodule only when its file exists', () => {
  assert.deepEqual(
    importedFiles(
      'python-from-package',
      appImporting(py('from .x import part, name', 'from .x import *'), [
        'part',
      ]),
    ),
    ['src/app/x/part.py'],
  );
});

test('private: absolute imports resolve across the Python roots, in every form', () => {
  const files = {
    'python/src/yea/__init__.py': DOC,
    'python/src/yea/text.py': DOC,
    'python/src/yea/pkg/__init__.py': DOC,
    'python/mcp/src/yea_mcp/__init__.py': DOC,
    'python/mcp/src/yea_mcp/run.py': py(
      'import os, json',
      'from yea import pkg, text',
      'from yea.pkg import name',
      'from yea.pkg.a import x',
      'import yea.pkg.b',
      'import yea.pkg.c as c',
      'from yea.pkg import d',
      'def lazy():',
      '    from yea.pkg.e import e',
    ),
  };
  const parts = ['a', 'b', 'c', 'd', 'e'];

  for (const part of parts) {
    files[`python/src/yea/pkg/${part}.py`] = DOC;
  }

  assert.deepEqual(
    importedFiles('python-roots', files, ['python/src', 'python/mcp/src']),
    parts.map((p) => `python/src/yea/pkg/${p}.py`),
  );
});

test('private: a name that is both a submodule and a symbol counts as the submodule', () => {
  const files = appImporting(py('from .x import part'), ['part']);

  files['src/app/x/__init__.py'] = py('part = "a symbol"');

  assert.deepEqual(importedFiles('python-tie', files), ['src/app/x/part.py']);
});

test('private: a leading _ keeps a module or package inside its parent', () => {
  const found = privateFound(
    'python-underscore',
    {
      'python/src/yea/__init__.py': py('from ._json import j'),
      'python/src/yea/_json.py': DOC,
      'python/src/yea/__about__.py': DOC,
      'python/src/yea/_inner/__init__.py': DOC,
      'python/src/yea/ns/_part.py': DOC,
      'python/src/yea/ns/run.py': py(
        'from ._part import p',
        'from .._json import j',
      ),
      'python/src/yea/run.py': py('from .ns._part import p'),
      'python/mcp/src/yea_mcp/__init__.py': py(
        'from yea._json import j',
        'from yea import _inner, __about__',
      ),
    },
    ['python/src', 'python/mcp/src'],
  );

  assert.deepEqual(found, [
    'python/mcp/src/yea_mcp/__init__.py: private (imports python/src/yea/_inner/__init__.py, which its leading _ makes private to python/src/yea/)',
    'python/mcp/src/yea_mcp/__init__.py: private (imports python/src/yea/_json.py, which its leading _ makes private to python/src/yea/)',
    'python/src/yea/run.py: private (imports python/src/yea/ns/_part.py, which its leading _ makes private to python/src/yea/ns/)',
  ]);
});

test('private: Python examples are read for their imports alone', () => {
  const dir = fixture('python-examples', {
    'python/src/yea/__init__.py': DOC,
    'python/src/yea/pkg/__init__.py': DOC,
    'python/src/yea/pkg/part.py': DOC,
    'python/examples/Quick-Start.py':
      'from yea import pkg\nfrom yea.pkg.part import x\n',
  });
  const found = findViolations(dir, ['python/src'], ['python/examples']);

  assert.deepEqual(report(compare(found, {})), [
    'python/examples/Quick-Start.py: private (imports python/src/yea/pkg/part.py from inside python/src/yea/pkg/; import python/src/yea/pkg/__init__.py instead)',
  ]);
});

test('private: a top-level package and a package without __init__.py are open', () => {
  assert.deepEqual(
    privateFound('python-open', {
      'src/run.py': py(
        'from app.text import t',
        'from app.plain.part import p',
      ),
      'src/app/__init__.py': DOC,
      'src/app/text.py': DOC,
      'src/app/plain/part.py': DOC,
    }),
    [],
  );
});

test('private: every Python import statement form is read', () => {
  const text = py(
    'from .x import (',
    '    a,',
    '    b as bee,',
    ')',
    'from .x import c, \\',
    '    d',
    'import os; from .x import e',
    'if TYPE_CHECKING: from .x import f',
    'def g():',
    '    from .x.g import g',
    'import app.x.h as h, app.x.i',
  );
  const parts = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];

  assert.deepEqual(
    importedFiles('python-forms', appImporting(text, parts)),
    parts.map((p) => `src/app/x/${p}.py`),
  );
});

test('private: imports in Python comments and strings are not read', () => {
  const text = [
    '"""A module.',
    '',
    'Use `from .x.a import a` for a.',
    '"""',
    '# from .x.b import b',
    "s = 'from .x.c import c'",
    "t = r'''",
    'from .x.d import d',
    "'''",
    'u = "\\"#"; from .x.e import e  # from .x.f import f',
    "from .x.g import g  # './x/a.js'",
  ].join('\n');
  const parts = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  assert.deepEqual(
    importedFiles('python-comments', appImporting(text, parts)),
    ['src/app/x/e.py', 'src/app/x/g.py'],
  );
});

test('ratchet: a private entry covers only the file it names', () => {
  const dir = fixture('private-by-target', {
    'src/run.ts': importing('./x/a.js', './x/b.js'),
    'src/x.ts': HEADER,
    'src/x/a.ts': HEADER,
    'src/x/b.ts': HEADER,
  });
  const result = compare(findViolations(dir, ['src']), {
    'src/run.ts': ['private src/x/a.ts'],
  });

  assert.deepEqual(report(result), [
    'src/run.ts: private (imports src/x/b.ts from inside src/x/; import src/x.ts instead)',
  ]);
});

test('ratchet: a listed private violation that no longer occurs fails', () => {
  const dir = fixture('private-fixed', {
    'src/run.ts': importing('./x.js'),
    'src/x.ts': importing('./x/part.js'),
    'src/x/part.ts': HEADER,
  });
  const result = compare(findViolations(dir, ['src']), {
    'src/run.ts': ['private src/x/part.ts'],
  });

  assert.deepEqual(report(result), [
    'src/run.ts: private src/x/part.ts (no longer occurs: remove it from the ratchet)',
  ]);
});
