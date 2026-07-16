/** Model-facing text for the fd and rg tools. */

export const FD_TOOL_DESCRIPTION =
  "Find files and directories by name with fd. Respects .gitignore by default. Results are limited to 1000 entries unless a higher limit is given; output is limited to 2000 lines or 50KB, and complete truncated output is saved to a temporary file.";

export const FD_PROMPT_SNIPPET =
  "Find files and directories by name with fd (fast, gitignore-aware).";

export const FD_PROMPT_GUIDELINES = [
  "Use fd as the primary tool for discovering files and directories by name, extension, or glob instead of bash with find or ls -R.",
  "Use rg instead of fd when searching file contents rather than file names.",
  "Keep using bash for complex multi-step workflows that pipe or post-process file listings.",
];

export const FD_PARAMETER_DESCRIPTIONS = {
  pattern:
    "Regex matched against file names (or a glob when glob is true). Omit to list everything under path.",
  path: "Directory to search. Defaults to the current working directory.",
  type: "Only return entries of this type: file, directory, or symlink.",
  extension: "Only return files with this extension, e.g. 'ts' or 'md'.",
  glob: "Treat pattern as a glob (e.g. '*.test.ts') instead of a regex.",
  hidden: "Include hidden files and directories. Defaults to false.",
  max_depth: "Maximum directory depth to descend (1-64).",
  limit: "Maximum number of results (1-10000). Defaults to 1000.",
};

export const RG_TOOL_DESCRIPTION =
  "Search file contents with ripgrep. Uses smart-case matching, respects .gitignore by default, and returns at most 100 matches per file unless a different limit is given. Output is limited to 2000 lines or 50KB; complete truncated output is saved to a temporary file.";

export const RG_PROMPT_SNIPPET =
  "Search file contents with ripgrep (fast regex content search).";

export const RG_PROMPT_GUIDELINES = [
  "Use rg as the primary tool for searching file contents instead of bash with grep.",
  "Use fd instead of rg when looking for files by name rather than content.",
  "Set fixed_strings on rg when searching for literal code snippets containing regex metacharacters.",
  "Keep using bash for complex multi-step workflows that combine searching with other commands.",
];

export const RG_PARAMETER_DESCRIPTIONS = {
  pattern: "Regex to search for (literal text when fixed_strings is true).",
  path: "File or directory to search. Defaults to the current working directory.",
  glob: "Only search files matching this glob, e.g. '*.ts' or 'src/**'.",
  file_type:
    "Only search files of this ripgrep type, e.g. 'ts', 'js', 'py', 'rust'.",
  case_sensitive:
    "true forces case-sensitive matching, false forces case-insensitive. Defaults to smart-case.",
  fixed_strings: "Treat pattern as a literal string instead of a regex.",
  hidden: "Search hidden files and directories. Defaults to false.",
  context: "Lines of context to show around each match (0-20).",
  limit: "Maximum matches per file (1-1000). Defaults to 100.",
};
