// Punto de entrada del shell: registra comandos de Linux y el CLI de AWS.
import './commands';
import './textutils';
import './awk';
import './linux';
import './aws';
import './docker';
import './kubectl';
import './git';
export { newShell, execLine, runString, type Shell, type CmdResult } from './interp';
