export function printUsage(output = console.log) {
  output(`Usage:
  antigravity-bus discover [--cwd <path>]
  antigravity-bus snapshot [--cwd <path>]
  antigravity-bus watch [--cwd <path>] [--interval <ms>] [--out-dir <path>]
  antigravity-bus dispatch --cwd <path> --prompt <text> [--mode <mode>] [--add-file <path>] [--wait-ms <ms>] [--bridge-dir <path>] [--wait-for-completion] [--completion-timeout-ms <ms>] [--auto-approve] [--approval-timeout-ms <ms>] [--auto-remediate] [--max-remediations <n>] [--supervisor-loop-timeout-ms <ms>]
  antigravity-bus run-status --run-id <id> [--out-dir <path>] [--refresh]
  antigravity-bus ipc-dispatch --cwd <path> --prompt <text> [--profile <name>] [--mode <mode>] [--add-file <path>] [--wait-ms <ms>] [--wait-for-new-cascade]
  antigravity-bus --help
  antigravity-bus --version

Examples:
  antigravity-bus discover
  antigravity-bus snapshot --cwd /absolute/path/to/workspace
  antigravity-bus watch --cwd /absolute/path/to/workspace --interval 4000
  antigravity-bus dispatch --cwd /absolute/path/to/workspace --prompt "Continue the task" --wait-for-completion --auto-approve --auto-remediate
  antigravity-bus run-status --run-id run-123 --refresh
  antigravity-bus ipc-dispatch --cwd /absolute/path/to/workspace --prompt "Continue the task" --wait-for-new-cascade
  npx antigravity-bus --help`);
}
