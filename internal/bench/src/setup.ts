import { chmodSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { binDir } from './paths.js';

const OHA_VERSION = 'v1.15.0';

const assetName = (): string => {
  const os =
    platform() === 'darwin'
      ? 'macos'
      : platform() === 'win32'
        ? 'windows'
        : 'linux';
  const cpu = arch() === 'arm64' ? 'arm64' : 'amd64';
  const suffix = os === 'windows' ? '.exe' : '';
  return `oha-${os}-${cpu}${suffix}`;
};

const target = `${binDir}/oha`;

if (await Bun.file(target).exists()) {
  console.log(`oha is already installed at ${target}`);
  process.exit(0);
}

const url = `https://github.com/hatoo/oha/releases/download/${OHA_VERSION}/${assetName()}`;
console.log(`Downloading ${url}`);
const response = await fetch(url);
if (!response.ok) {
  console.error(
    `Download failed with ${response.status}. Install oha yourself and put it on PATH.`,
  );
  process.exit(1);
}
await Bun.write(target, response);
chmodSync(target, 0o755);

const proc = Bun.spawn([target, '--version'], { stdout: 'pipe' });
console.log(
  `Installed ${(await new Response(proc.stdout).text()).trim()} at ${target}`,
);
