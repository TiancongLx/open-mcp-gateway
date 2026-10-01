// scripts/stage.ts — postbuild staging for open-mcp-gateway.
//
// Called automatically by `bun run build` via the `postbuild` lifecycle hook
// (Bun runs pre<script>/post<script>; a failing pre<script> aborts the main script).
//
// Stages the compiled artifact to ~/.local/bin/omg.exe (the Servy hosting object),
// separating the dev tree from the deployed binary. Modes:
//   symlink (default)  path-based link; always tracks the latest build output.
//   hardlink           inode-based link; goes stale if a rebuild replaces the file,
//                      which the hash gate below will catch and fail on.
//   copy               physical copy; fully decouples deployment from the dev tree.
//
// Gate: SHA-256(link) must equal SHA-256(source); mismatch exits non-zero so the
// build chain surfaces a stale or broken staging immediately.
//
// Note (Windows): creating a file symlink requires Developer Mode or an elevated
// shell. If symlink creation fails, rerun with STAGE_MODE=copy.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const src = join(import.meta.dir, '..', 'build', 'open-mcp-gateway.exe');
const dst = join(homedir(), '.local', 'bin', 'omg.exe');
const mode = (process.env.STAGE_MODE ?? 'symlink').toLowerCase();

if (!existsSync(src)) {
  console.error(`stage: source missing: ${src}`);
  process.exit(1);
}

mkdirSync(join(homedir(), '.local', 'bin'), { recursive: true });

// Remove any previous staging entry (never touches the link target).
rmSync(dst, { force: true });

if (mode === 'symlink') {
  symlinkSync(src, dst, 'file');
} else if (mode === 'hardlink') {
  linkSync(src, dst);
} else if (mode === 'copy') {
  copyFileSync(src, dst);
} else {
  console.error(`stage: unknown STAGE_MODE=${mode} (expected symlink|hardlink|copy)`);
  process.exit(1);
}

const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const srcHash = sha256(src);
const dstHash = sha256(dst);

if (srcHash !== dstHash) {
  console.error(`stage: hash mismatch after ${mode} staging`);
  console.error(`  src ${srcHash} ${src}`);
  console.error(`  dst ${dstHash} ${dst}`);
  process.exit(1);
}

console.log(`stage: ok mode=${mode} sha256=${srcHash.slice(0, 16)} -> ${dst}`);
