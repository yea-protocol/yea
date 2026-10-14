/**
 * The PR body check (CONTRIBUTING.md#how-work-is-tracked): a pull request's
 * description links its issue, fills in the template's Summary and Evidence,
 * and gives a one-way or two-way door and a blast radius under Merge danger.
 * It checks the shape only, never what the sections say. CI passes the body
 * in PR_BODY.
 */
import { fileURLToPath } from 'node:url';

/** The free-text sections, with the rule each one's absence breaks. */
const SECTIONS = [
  { heading: 'Summary', rule: 'summary' },
  { heading: 'Evidence', rule: 'evidence' },
];

/** The labelled lines under Merge danger, each needing a value. */
const MERGE_DANGER = [
  {
    rule: 'door',
    pattern: /^\*\*Door:\*\*[ \t]*(one|two)-way\b/im,
    message: 'Set "**Door:**" under Merge danger to one-way or two-way',
  },
  {
    rule: 'blast-radius',
    pattern: /^\*\*Blast radius:\*\*[ \t]*\S/im,
    message: 'Say what breaks if this is wrong after "**Blast radius:**"',
  },
];

/** An issue link on its own line, as GitHub reads it. */
const LINK = /^(closes|fixes|resolves|part of) #\d+/im;

/** An HTML comment, as the template's hints are written. */
const COMMENT = /<!--[\s\S]*?-->/g;

/** `body` without its HTML comments, so the template's hints never count. */
function visible(body) {
  return (body ?? '').replace(COMMENT, '');
}

/** The text under the level-2 `heading`, or undefined when it's missing. */
function section(text, heading) {
  const start = new RegExp(`^##[ \\t]+${heading}[ \\t]*$`, 'im').exec(text);

  if (start === null) {
    return undefined;
  }

  const rest = text.slice(start.index + start[0].length);
  const next = /^#{1,2}[ \t]/m.exec(rest);

  return next === null ? rest : rest.slice(0, next.index);
}

/** Summary and Evidence, when missing or empty, as problems. */
function sectionProblems(text) {
  return SECTIONS.filter(({ heading }) => {
    const under = section(text, heading);

    return under === undefined || under.trim() === '';
  }).map(({ heading, rule }) => ({
    rule,
    message: `Fill in "## ${heading}" (see .github/pull_request_template.md)`,
  }));
}

/** Merge danger's missing section, or the labelled lines in it with no value. */
function mergeDangerProblems(text) {
  const under = section(text, 'Merge danger');

  if (under === undefined) {
    return [
      {
        rule: 'merge-danger',
        message: 'Add "## Merge danger" with a door and a blast radius',
      },
    ];
  }

  return MERGE_DANGER.filter(({ pattern }) => !pattern.test(under)).map(
    ({ rule, message }) => ({ rule, message }),
  );
}

/** The problems with a PR `body`, each a `{ rule, message }`; none means it passes. */
export function checkPrBody(body) {
  const text = visible(body);
  const link = LINK.test(text)
    ? []
    : [
        {
          rule: 'link',
          message:
            'Link the issue on its own line: "Closes #n", or "Part of #n"',
        },
      ];

  return [...link, ...sectionProblems(text), ...mergeDangerProblems(text)];
}

/** Prints each problem as a GitHub annotation and fails when there are any. */
function main() {
  const problems = checkPrBody(process.env.PR_BODY);

  for (const { message } of problems) {
    console.log(`::error title=PR description::${message}`);
  }

  if (problems.length > 0) {
    console.error('\nEdit the PR description; the check re-runs on save.');
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
