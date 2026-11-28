import { execFileSync } from 'node:child_process';
// Examine names only, never read the contents of an unwanted tracked credential.
const tracked = execFileSync('git',['ls-files','--cached','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const forbidden = tracked.filter(p => /(?:^|\/)\.env(?:$|\.)/i.test(p) && !/(?:^|\/)\.env\.example$/i.test(p)
  || /\.bak$/i.test(p) || /^(?:dist[^/]*|release)\//i.test(p));
if (forbidden.length) { console.error('Remove these local/generated paths from the index:',forbidden.join(', ')); process.exitCode=1; }
else console.log('Index contains no forbidden env, backup, release or build artifacts.');
