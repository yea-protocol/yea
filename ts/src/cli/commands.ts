/** Every `yea` command, by name: the table `run` dispatches on and `yea help` reads. */
import { cmdApprove } from './approve.js';
import type { Command } from './command.js';
import { cmdDoctor } from './doctor.js';
import {
  cmdDelegate,
  cmdGrant,
  cmdGrantImport,
  cmdInit,
  cmdInspect,
  cmdServiceId,
  cmdWhoami,
} from './identity.js';
import {
  cmdAdd,
  cmdInstall,
  cmdRemove,
  cmdServices,
  cmdUninstall,
} from './install.js';
import {
  cmdDemo,
  cmdExamples,
  cmdMcp,
  cmdOpenapi,
  cmdTestDrive,
} from './launch.js';
import {
  cmdAsk,
  cmdCommit,
  cmdDo,
  cmdExpand,
  cmdHello,
  cmdIntent,
  cmdUndo,
} from './talk.js';

/** The commands by name; `setup` is the old name of `install`. */
export const COMMANDS: ReadonlyMap<string, Command> = new Map<string, Command>([
  ['install', cmdInstall],
  ['setup', cmdInstall],
  ['add', cmdAdd],
  ['remove', cmdRemove],
  ['services', cmdServices],
  ['doctor', cmdDoctor],
  ['uninstall', cmdUninstall],
  ['init', cmdInit],
  ['whoami', cmdWhoami],
  ['service-id', cmdServiceId],
  ['grant', cmdGrant],
  ['grant-import', cmdGrantImport],
  ['delegate', cmdDelegate],
  ['inspect', cmdInspect],
  ['approve', cmdApprove],
  ['hello', cmdHello],
  ['ask', cmdAsk],
  ['intent', cmdIntent],
  ['commit', cmdCommit],
  ['undo', cmdUndo],
  ['expand', cmdExpand],
  ['do', cmdDo],
  ['test-drive', cmdTestDrive],
  ['demo', cmdDemo],
  ['examples', cmdExamples],
  ['mcp', cmdMcp],
  ['openapi', cmdOpenapi],
]);
