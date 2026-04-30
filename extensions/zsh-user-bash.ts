import { basename } from "node:path";
import {
  createLocalBashOperations,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function getZshPath() {
  if (process.env.PI_USER_BASH_SHELL) return process.env.PI_USER_BASH_SHELL;
  if (process.env.SHELL && basename(process.env.SHELL) === "zsh") {
    return process.env.SHELL;
  }
  return "/bin/zsh";
}

export default function (pi: ExtensionAPI) {
  const local = createLocalBashOperations();

  pi.on("user_bash", () => {
    return {
      operations: {
        exec(command, cwd, options) {
          // Run zsh as a non-interactive shell. `-i` sources ~/.zshrc, which may
          // start prompt integrations like gitstatus/powerlevel10k. Pi executes
          // user bash commands without a real interactive job-control terminal,
          // so those integrations can emit warnings such as:
          //   setopt: can't change option: monitor
          //   gitstatus failed to initialize
          const zshCommand = `exec ${shellQuote(getZshPath())} -fc ${shellQuote(command)}`;
          return local.exec(zshCommand, cwd, options);
        },
      },
    };
  });
}
