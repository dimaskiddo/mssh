import { test, expect, spyOn } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as nodeOs from "node:os";
import { withScratchDir } from "./helpers";
import { pickDefaultKeyName, pulledKeyNamesFor } from "../src/internal";
import { discoverDefaultKeyPath, listPulledKeys } from "../src/local-keys";
import { localKeyName } from "../src/remote-keys";

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

test("pulledKeyNamesFor matches only this bastion's keys and sorts them", () => {
  const names = ["bastion-1_rsa.pem", "other_rsa.pem", "bastion-1_ed25519.pem"];
  expect(pulledKeyNamesFor("bastion-1", names)).toEqual(["bastion-1_ed25519.pem", "bastion-1_rsa.pem"]);
});

test("pulledKeyNamesFor requires the .pem suffix", () => {
  expect(pulledKeyNamesFor("bastion-1", ["bastion-1_rsa", "bastion-1_rsa.pem.bak"])).toEqual([]);
});

test("pulledKeyNamesFor rejects the bare prefix with an empty suffix", () => {
  expect(pulledKeyNamesFor("bastion-1", ["bastion-1_.pem"])).toEqual([]);
});

test("pulledKeyNamesFor returns empty when nothing matches", () => {
  expect(pulledKeyNamesFor("bastion-1", [])).toEqual([]);
});

test("pulledKeyNamesFor accepts what localKeyName actually produces", () => {
  const produced = localKeyName("bastion-1", "id_rsa");
  expect(pulledKeyNamesFor("bastion-1", [produced])).toEqual([produced]);
});

test("listPulledKeys returns absolute paths under keysDir()", () => {
  withFakeHome((home) => {
    const keys = join(home, ".mssh", "keys");
    mkdirSync(keys, { recursive: true });
    writeFileSync(join(keys, "bastion-1_rsa.pem"), "fakekey");

    expect(listPulledKeys("bastion-1")).toEqual([join(home, ".mssh", "keys", "bastion-1_rsa.pem")]);
  });
});

test("listPulledKeys returns empty and does not create keysDir() when it does not exist", () => {
  withFakeHome((home) => {
    expect(listPulledKeys("bastion-1")).toEqual([]);
    expect(existsSync(join(home, ".mssh", "keys"))).toBe(false);
  });
});

test("listPulledKeys ignores a subdirectory named like a key", () => {
  withFakeHome((home) => {
    const keys = join(home, ".mssh", "keys");
    mkdirSync(join(keys, "bastion-1_rsa.pem"), { recursive: true });

    expect(listPulledKeys("bastion-1")).toEqual([]);
  });
});
