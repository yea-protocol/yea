/**
 * The light-theme code colours: Shiki's github-light with the token colours that fall under
 * 4.5:1 on the paper code background (#ECE8DF) darkened, keeping their hues. github-light was
 * tuned for white.
 */
import githubLight from '@shikijs/themes/github-light';

type Theme = typeof githubLight;
type TokenColor = NonNullable<Theme['tokenColors']>[number];

/** github-light colour → the darkened colour used on paper, keyed in lowercase. */
const DARKER: Record<string, string> = {
  '#6a737d': '#5b636c', // comments
  '#d73a49': '#b2303d', // keywords, storage
  '#e36209': '#a14606', // parameters, variables
  '#22863a': '#1c6f30', // tags, inserted lines
};

export const paperLight: Theme = {
  ...githubLight,
  name: 'yea-paper-light',
  tokenColors: githubLight.tokenColors?.map(darken),
};

function darken(token: TokenColor): TokenColor {
  const fg = token.settings.foreground?.toLowerCase();
  const to = fg ? DARKER[fg] : undefined;

  return to
    ? { ...token, settings: { ...token.settings, foreground: to } }
    : token;
}
