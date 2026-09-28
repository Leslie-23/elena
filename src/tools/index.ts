import type { Tool } from "./types.js";
import { listDirectoryTool, readFileTool, searchTool } from "./files.js";
import { gitDiffTool, gitLogTool, gitStatusTool } from "./git.js";
import { listeningPortsTool, portOwnerTool } from "./system.js";
import { runCommandTool } from "./shell.js";
import { forgetTool, recallTool, rememberTool } from "./memory.js";
import { askExpertTool, delegateTool } from "./agents.js";
import { clipboardTool, macControlTool, macOpenTool, macStatusTool } from "./mac.js";
import { listProcessesTool, processLogsTool, scanProjectTool, startProcessTool, stopProcessTool } from "./processes.js";

export const tools: Tool[] = [
  readFileTool,
  listDirectoryTool,
  searchTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  portOwnerTool,
  listeningPortsTool,
  runCommandTool,
  startProcessTool,
  listProcessesTool,
  processLogsTool,
  stopProcessTool,
  scanProjectTool,
  delegateTool,
  askExpertTool,
  macOpenTool,
  macStatusTool,
  macControlTool,
  clipboardTool,
  rememberTool,
  recallTool,
  forgetTool,
];

export const toolsByName = new Map(tools.map((t) => [t.schema.function.name, t]));
