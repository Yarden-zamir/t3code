import { describe, expect, it } from "vite-plus/test";

import {
  terminalCommandTitle,
  terminalThreadCommandTitle,
  terminalThreadTitle,
} from "./forkTerminalThreads.ts";

// The fake tokens are split, so that secret scanners do not flag the test file.
const joined = (...parts: ReadonlyArray<string>) => parts.join("");

describe("terminalCommandTitle", () => {
  it("keeps the program and up to two plain words after it", () => {
    expect(terminalCommandTitle(" git push origin main ")).toBe("git push origin");
    expect(terminalCommandTitle("npm run dev")).toBe("npm run dev");
    expect(terminalCommandTitle("sleep 700")).toBe("sleep");
    expect(terminalCommandTitle("./scripts/deploy.sh production")).toBe("deploy.sh production");
    expect(terminalCommandTitle("cd ~/work && make")).toBe("cd");
  });

  it("leaves out real secret shapes", () => {
    const secrets = [
      joined("ghp", "_16C7e42F292c6912E7710c838347Ae178B4a"),
      joined("github", "_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK"),
      joined("sk-ant", "-api03-AbCdEf0123456789AbCdEf0123456789"),
      joined("sk-proj", "-AbCdEf0123456789AbCdEf0123456789"),
      joined("xoxb", "-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx"),
      joined("AKIA", "IOSFODNN7EXAMPLE"),
      joined("wJalrXUtnFEMI", "/K7MDENG/bPxRfiCYEXAMPLEKEY"),
      joined(
        "eyJhbGciOiJIUzI1NiJ9",
        ".eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ),
    ];
    for (const secret of secrets) {
      const commandLines = [
        `export GITHUB_TOKEN=${secret}`,
        `GITHUB_TOKEN=${secret} gh pr list`,
        `curl -H "Authorization: Bearer ${secret}" https://api.example.com`,
        `gh auth login --with-token ${secret}`,
        `mytool --token ${secret}`,
        `mytool --token=${secret}`,
        `mysql -u root --password ${secret}`,
        `mysql -u root -p${secret}`,
        `mytool ${secret}`,
        `echo ${secret} | docker login --password-stdin`,
        // A token pasted into the shell by mistake runs as a command.
        secret,
      ];
      for (const commandLine of commandLines) {
        expect(terminalCommandTitle(commandLine) ?? "").not.toContain(secret);
      }
    }
    expect(terminalCommandTitle("GITHUB_TOKEN=x NODE_ENV=production gh pr list")).toBe(
      "gh pr list",
    );
    expect(terminalCommandTitle("export GITHUB_TOKEN=x")).toBe("export");
    expect(terminalCommandTitle("sshpass -p hunter2 ssh host")).toBe("sshpass");
    expect(terminalCommandTitle("mytool hunter2")).toBe("mytool");
    expect(terminalCommandTitle("curl -H 'Authorization: Bearer x' https://a.b")).toBe("curl");
  });

  it("gives nothing for a line without a program", () => {
    expect(terminalCommandTitle("   ")).toBeUndefined();
    expect(terminalCommandTitle(undefined)).toBeUndefined();
    expect(terminalCommandTitle("TOKEN=x")).toBeUndefined();
    expect(terminalCommandTitle('"$EDITOR" notes')).toBeUndefined();
  });
});

describe("terminalThreadTitle", () => {
  it("names a thread after the program and subcommand of its command line first", () => {
    expect(
      terminalThreadTitle({ command: " docker compose up -d ", program: "docker", shell: "zsh" }),
    ).toBe("docker compose up");
  });

  it("never names a thread after a secret in its command line", () => {
    expect(
      terminalThreadTitle({
        command: `export GITHUB_TOKEN=${joined("ghp", "_16C7e42F292c6912E7710c838347Ae178B4a")}`,
        shell: "zsh",
      }),
    ).toBe("export");
  });

  it("names a thread without a command line after the running program", () => {
    expect(terminalThreadTitle({ command: undefined, program: "vim", shell: "zsh" })).toBe("vim");
  });

  it("names a custom shell that reports no command after the shell", () => {
    expect(terminalThreadTitle({ command: "  ", shell: "python" })).toBe("python");
  });

  it("names the default shell with nothing known Terminal", () => {
    expect(terminalThreadTitle({ command: undefined, shell: undefined })).toBe("Terminal");
  });

  it("keeps a long program name to the title limit", () => {
    expect(terminalThreadTitle({ command: "x".repeat(300), shell: undefined })).toHaveLength(80);
  });
});

describe("terminalThreadCommandTitle", () => {
  it("names a thread that started without a command after its first command", () => {
    expect(terminalThreadCommandTitle({ title: "zsh", command: " ls -la ", shell: "zsh" })).toBe(
      "ls",
    );
    expect(terminalThreadCommandTitle({ title: "Terminal", command: "ls", shell: undefined })).toBe(
      "ls",
    );
  });

  it("keeps a title that came from a command or from the user", () => {
    expect(terminalThreadCommandTitle({ title: "sleep 700", command: "ls", shell: "zsh" })).toBe(
      null,
    );
    expect(terminalThreadCommandTitle({ title: "My shell", command: "ls", shell: "zsh" })).toBe(
      null,
    );
  });

  it("keeps the title while no command ran", () => {
    expect(terminalThreadCommandTitle({ title: "zsh", command: "  ", shell: "zsh" })).toBe(null);
  });
});
