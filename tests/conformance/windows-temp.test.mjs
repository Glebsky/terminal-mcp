import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { call, external, scenario } from './_fixture.mjs';

// Give TEMP two spellings on purpose without requiring Windows 8.3 names to be enabled.
// The alias and its target both live in this test's own temporary directory.
test('Windows TEMP may have a different spelling from its real directory',
  { skip: process.platform !== 'win32' || external }, async t => {
    const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'spec009-temp-spelling-'));
    const real = path.join(base, 'Runner Temporary Files'), alias = path.join(base, 'RunnerTemp');
    const oldTemp = process.env.TEMP, oldTmp = process.env.TMP;
    try {
      await fs.mkdir(real);
      await fs.symlink(real, alias, 'junction');
      assert.equal(path.relative(real, await fs.realpath(alias)), '');
      process.env.TEMP = process.env.TMP = alias;
      await t.test('a dedicated fixture reads and writes using its reported root', async child => {
        const { client, dir, changeCwd } = await scenario(child);
        await changeCwd();
        await call(client, 'file_write', {path:'same-root.txt', data:'fixture only'});
        assert.equal(await fs.readFile(path.join(await fs.realpath(dir), 'same-root.txt'),'utf8'), 'fixture only');
      }); // The child has stopped its server before the parent removes the alias.
    } finally {
      if (oldTemp === undefined) delete process.env.TEMP; else process.env.TEMP = oldTemp;
      if (oldTmp === undefined) delete process.env.TMP; else process.env.TMP = oldTmp;
      await fs.rm(base, {recursive:true, force:true, maxRetries:4});
    }
  });
