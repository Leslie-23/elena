import type { Tool } from "./types.js";
import { listDirectoryTool, readFileTool, searchTool } from "./files.js";
import { gitDiffTool, gitLogTool, gitStatusTool } from "./git.js";
import { portOwnerTool } from "./system.js";
import { runCommandTool } from "./shell.js";
import { forgetTool, recallTool, rememberTool } from "./memory.js";
import { listProcessesTool, processLogsTool, scanProjectTool, startProcessTool, stopProcessTool } from "./processes.js";

export const tools: Tool[] = [
  readFileTool,
  listDirectoryTool,
  searchTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  portOwnerTool,
  runCommandTool,
  startProcessTool,
  listProcessesTool,
  processLogsTool,
  stopProcessTool,
  scanProjectTool,
  rememberTool,
  recallTool,
  forgetTool,
];

export const toolsByName = new Map(tools.map((t) => [t.schema.function.name, t]));
