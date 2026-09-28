// One source for every pid-suffixed temp path mssh creates, so a producer
// and fs/sweep.ts's pid parser can never drift apart on the pattern.
// randomSuffix must come from crypto randomness (randomBytes), never a
// counter, pid or timestamp.
export function tempConfigName(pid: number, randomSuffix: string): string {
  return `cfg-${pid}-${randomSuffix}`;
}

export function controlPathName(pid: number, randomSuffix: string): string {
  return `cm-${pid}-${randomSuffix}`;
}

export function keyTempName(pid: number, randomSuffix: string): string {
  return `key-${pid}-${randomSuffix}`;
}

// Unlike the three producers above, these are appended directly onto an
// existing path, not joined into their own run/ directory entry.
export function tmpSuffix(pid: number, randomSuffix: string): string {
  return `.tmp-${pid}-${randomSuffix}`;
}

export function newSuffix(pid: number, randomSuffix: string): string {
  return `.new-${pid}-${randomSuffix}`;
}

export function oldSuffix(pid: number, randomSuffix: string): string {
  return `.old-${pid}-${randomSuffix}`;
}

export const CFG_NAME = /^cfg-(\d+)-[0-9a-f]+$/;
export const KEY_NAME = /^key-(\d+)-[0-9a-f]+$/;
export const CM_NAME = /^cm-(\d+)-[0-9a-f]+$/;
export const TMP_NAME = /\.tmp-(\d+)-[0-9a-f]+$/;
export const BIN_LEFTOVER_NAME = /\.(?:old|new)-(\d+)-[0-9a-f]+$/;

function pidFrom(re: RegExp): (name: string) => number | undefined {
  return (name) => {
    const digits = re.exec(name)?.[1];
    return digits === undefined ? undefined : Number(digits);
  };
}

export const cfgPid = pidFrom(CFG_NAME);
export const keyPid = pidFrom(KEY_NAME);

export const cmPid = pidFrom(CM_NAME);

export const tmpPid = pidFrom(TMP_NAME);
export const binLeftoverPid = pidFrom(BIN_LEFTOVER_NAME);
