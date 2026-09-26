import type { Tool } from "./types.js";
import { listDirectoryTool, readFileTool, searchTool } from "./files.js";
import { gitDiffTool, gitLogTool, gitStatusTool } from "./git.js";
import { portOwnerTool } from "./system.js";

export const tools: Tool[] = [
  readFileTool,
  listDirectoryTool,
  searchTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  portOwnerTool,
];

export const toolsByName = new Map(tools.map((t) => [t.schema.function.name, t]));
