/**
 * The PR body check (CONTRIBUTING.md#how-work-is-tracked): a pull request's
 * description links its issue and fills in the template's Summary, Evidence
 * and Merge danger, with a one-way or two-way door. It checks the shape only,
 * never what the sections say. CI passes the body in PR_BODY.
 */
import { fileURLToPath } from 'node:url';

/** The sections every body has, with the rule each one's absence breaks. */
export const SECTIONS = [
  { heading: 'Summary', rule: 'summary' },
  { heading: 'Evidence', rule: 'evidence' },
  { heading: 'Merge danger', rule: 'merge-danger' },
];

const LINK = /^(closes|fixes|resolves|part of) #\d+/im;
const DOOR = /^\*\*Door:\*\*[ \t]*(one|two)-way\b/im;
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

/** The sections that are missing or empty, as problems. */
function sectionProblems(text) {
  return SECTIONS.filter(({ heading }) => {
    const under = section(text, heading);

    return under === undefined || under.trim() === '';
  }).map(({ heading, rule }) => ({
    rule,
    message: `Fill in "## ${heading}" (see .github/pull_request_template.md)`,
  }));
}

/** The problems with a PR `body`, each a `{ rule, message }`; none means it passes. */
export function checkPrBody(body) {
  const text = visible(body);
  const problems = [];

  if (!LINK.test(text)) {
    problems.push({
      rule: 'link',
      message: 'Link the issue on its own line: "Closes #n", or "Part of #n"',
    });
  }

  problems.push(...sectionProblems(text));

  if (!DOOR.test(text)) {
    problems.push({
      rule: 'door',
      message: 'Set "**Door:**" under Merge danger to one-way or two-way',
    });
  }

  return problems;
}

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
