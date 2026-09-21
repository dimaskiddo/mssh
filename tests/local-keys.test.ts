import { test, expect, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as nodeOs from "node:os";
import { withScratchDir } from "./helpers";
import { pickDefaultKeyName } from "../src/internal";
import { discoverDefaultKeyPath } from "../src/local-keys";

test("pickDefaultKeyName prefers id_rsa even when it sorts after another candidate", () => {
  expect(pickDefaultKeyName(["acme.pem", "id_ed25519", "id_rsa"])).toBe("id_rsa");
});

test("pickDefaultKeyName walks the preference order when id_rsa is absent", () => {
  expect(pickDefaultKeyName(["id_ecdsa", "id_ed25519"])).toBe("id_ed25519");
});

test("pickDefaultKeyName falls back to the alphabetically-first candidate when no preferred name matches", () => {
  expect(pickDefaultKeyName(["work-key", "acme.pem"])).toBe("acme.pem");
});

test("pickDefaultKeyName applies the same exclusions as the remote picker", () => {
  const names = ["id_rsa.pub", "known_hosts", "known_hosts.old", "authorized_keys", "config", "environment", "rc"];
  expect(pickDefaultKeyName(names)).toBeUndefined();
});

test("pickDefaultKeyName returns undefined for an empty directory", () => {
  expect(pickDefaultKeyName([])).toBeUndefined();
});

test("pickDefaultKeyName rejects a dot-only name that the character class alone would pass", () => {
  expect(pickDefaultKeyName([".", ".."])).toBeUndefined();
});

// The scratch dir doubles as the fake home so the homedir() spy and the real
// filesystem agree — unlike app-config.test.ts's withHome, which fakes only the string.
function withFakeHome(fn: (home: string) => void): void {
  withScratchDir("mssh-local-keys-test-", (dir) => {
    const spy = spyOn(nodeOs, "homedir").mockReturnValue(dir);
    try {
      fn(dir);
    } finally {
      spy.mockRestore();
    }
  });
}

test("discoverDefaultKeyPath returns the absolute path to the picked key", () => {
  withFakeHome((home) => {
    const sshDir = join(home, ".ssh");
    mkdirSync(sshDir);
    writeFileSync(join(sshDir, "id_rsa"), "fakekey");
    writeFileSync(join(sshDir, "id_rsa.pub"), "fakepub");

    expect(discoverDefaultKeyPath()).toBe(join(home, ".ssh", "id_rsa"));
  });
});

test("discoverDefaultKeyPath returns undefined when ~/.ssh does not exist", () => {
  withFakeHome(() => {
    expect(discoverDefaultKeyPath()).toBeUndefined();
  });
});

test("discoverDefaultKeyPath returns undefined when ~/.ssh holds only non-key files", () => {
  withFakeHome((home) => {
    const sshDir = join(home, ".ssh");
    mkdirSync(sshDir);
    writeFileSync(join(sshDir, "config"), "");
    writeFileSync(join(sshDir, "known_hosts"), "");

    expect(discoverDefaultKeyPath()).toBeUndefined();
  });
});

test("discoverDefaultKeyPath ignores a subdirectory that would otherwise pass the name filter", () => {
  withFakeHome((home) => {
    const sshDir = join(home, ".ssh");
    mkdirSync(join(sshDir, "sockets"), { recursive: true });

    expect(discoverDefaultKeyPath()).toBeUndefined();
  });
});
