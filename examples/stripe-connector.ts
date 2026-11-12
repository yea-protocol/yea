// #region library
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { yea } from '@yea-protocol/mcp';
import { stripeServer } from '@yea-protocol/stripe';

const approvals = yea({ name: 'yea-stripe', transport: 'stdio' });
const key = process.env.STRIPE_SECRET_KEY ?? '';

serveStdio(stripeServer({ key, approvals }));
// #endregion library
