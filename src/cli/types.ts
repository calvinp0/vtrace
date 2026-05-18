export interface CliOptions {
  cwd?: string;
  dbPath?: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ResolvedCliOptions {
  cwd: string;
  dbPath?: string;
}
