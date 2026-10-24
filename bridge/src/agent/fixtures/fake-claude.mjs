#!/usr/bin/env node
// 测试用的假 claude：记录参数和工作目录，按行输出 FAKE_FIXTURE 指向的文件，以 FAKE_EXIT 退出
import { readFileSync, writeFileSync } from 'node:fs';

if (process.env.FAKE_ARGS_FILE) {
  writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
}
if (process.env.FAKE_FIXTURE) process.stdout.write(readFileSync(process.env.FAKE_FIXTURE));
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);
process.exitCode = Number(process.env.FAKE_EXIT ?? 0);
