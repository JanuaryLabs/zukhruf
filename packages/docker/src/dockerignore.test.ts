import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { describe } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';

import {
  compile,
  contextPaths,
  matches,
  readDockerignore,
} from './dockerignore.ts';

interface PatternCase {
  /** The test of patternmatcher_test.go at v0.6.1: its type and line, or its function. */
  name: string;
  patterns: string[];
  path: string;
  /** What Go's MatchesOrParentMatches gives, or 'error' for a malformed pattern. */
  excluded: boolean | 'error';
}

/** Each case of patternmatcher_test.go at moby/patternmatcher 5a6d8429a19b (v0.6.1). */
const PATTERN_CASES: PatternCase[] = [
  {
    name: 'matchesTestCase:120',
    patterns: ['**'],
    path: 'file',
    excluded: true,
  },
  {
    name: 'matchesTestCase:121',
    patterns: ['**'],
    path: 'file/',
    excluded: true,
  },
  {
    name: 'matchesTestCase:122',
    patterns: ['**/'],
    path: 'file',
    excluded: true,
  },
  {
    name: 'matchesTestCase:123',
    patterns: ['**/'],
    path: 'file/',
    excluded: true,
  },
  { name: 'matchesTestCase:124', patterns: ['**'], path: '/', excluded: true },
  { name: 'matchesTestCase:125', patterns: ['**/'], path: '/', excluded: true },
  {
    name: 'matchesTestCase:126',
    patterns: ['**'],
    path: 'dir/file',
    excluded: true,
  },
  {
    name: 'matchesTestCase:127',
    patterns: ['**/'],
    path: 'dir/file',
    excluded: true,
  },
  {
    name: 'matchesTestCase:128',
    patterns: ['**'],
    path: 'dir/file/',
    excluded: true,
  },
  {
    name: 'matchesTestCase:129',
    patterns: ['**/'],
    path: 'dir/file/',
    excluded: true,
  },
  {
    name: 'matchesTestCase:130',
    patterns: ['**/**'],
    path: 'dir/file',
    excluded: true,
  },
  {
    name: 'matchesTestCase:131',
    patterns: ['**/**'],
    path: 'dir/file/',
    excluded: true,
  },
  {
    name: 'matchesTestCase:132',
    patterns: ['dir/**'],
    path: 'dir/file',
    excluded: true,
  },
  {
    name: 'matchesTestCase:133',
    patterns: ['dir/**'],
    path: 'dir/file/',
    excluded: true,
  },
  {
    name: 'matchesTestCase:134',
    patterns: ['dir/**'],
    path: 'dir/dir2/file',
    excluded: true,
  },
  {
    name: 'matchesTestCase:135',
    patterns: ['dir/**'],
    path: 'dir/dir2/file/',
    excluded: true,
  },
  {
    name: 'matchesTestCase:136',
    patterns: ['**/dir'],
    path: 'dir',
    excluded: true,
  },
  {
    name: 'matchesTestCase:137',
    patterns: ['**/dir'],
    path: 'dir/file',
    excluded: true,
  },
  {
    name: 'matchesTestCase:138',
    patterns: ['**/dir2/*'],
    path: 'dir/dir2/file',
    excluded: true,
  },
  {
    name: 'matchesTestCase:139',
    patterns: ['**/dir2/*'],
    path: 'dir/dir2/file/',
    excluded: true,
  },
  {
    name: 'matchesTestCase:140',
    patterns: ['**/dir2/**'],
    path: 'dir/dir2/dir3/file',
    excluded: true,
  },
  {
    name: 'matchesTestCase:141',
    patterns: ['**/dir2/**'],
    path: 'dir/dir2/dir3/file/',
    excluded: true,
  },
  {
    name: 'matchesTestCase:142',
    patterns: ['**file'],
    path: 'file',
    excluded: true,
  },
  {
    name: 'matchesTestCase:143',
    patterns: ['**file'],
    path: 'dir/file',
    excluded: true,
  },
  {
    name: 'matchesTestCase:144',
    patterns: ['**/file'],
    path: 'dir/file',
    excluded: true,
  },
  {
    name: 'matchesTestCase:145',
    patterns: ['**file'],
    path: 'dir/dir/file',
    excluded: true,
  },
  {
    name: 'matchesTestCase:146',
    patterns: ['**/file'],
    path: 'dir/dir/file',
    excluded: true,
  },
  {
    name: 'matchesTestCase:147',
    patterns: ['**/file*'],
    path: 'dir/dir/file',
    excluded: true,
  },
  {
    name: 'matchesTestCase:148',
    patterns: ['**/file*'],
    path: 'dir/dir/file.txt',
    excluded: true,
  },
  {
    name: 'matchesTestCase:149',
    patterns: ['**/file*txt'],
    path: 'dir/dir/file.txt',
    excluded: true,
  },
  {
    name: 'matchesTestCase:150',
    patterns: ['**/file*.txt'],
    path: 'dir/dir/file.txt',
    excluded: true,
  },
  {
    name: 'matchesTestCase:151',
    patterns: ['**/file*.txt*'],
    path: 'dir/dir/file.txt',
    excluded: true,
  },
  {
    name: 'matchesTestCase:152',
    patterns: ['**/**/*.txt'],
    path: 'dir/dir/file.txt',
    excluded: true,
  },
  {
    name: 'matchesTestCase:153',
    patterns: ['**/**/*.txt2'],
    path: 'dir/dir/file.txt',
    excluded: false,
  },
  {
    name: 'matchesTestCase:154',
    patterns: ['**/*.txt'],
    path: 'file.txt',
    excluded: true,
  },
  {
    name: 'matchesTestCase:155',
    patterns: ['**/**/*.txt'],
    path: 'file.txt',
    excluded: true,
  },
  {
    name: 'matchesTestCase:156',
    patterns: ['a**/*.txt'],
    path: 'a/file.txt',
    excluded: true,
  },
  {
    name: 'matchesTestCase:157',
    patterns: ['a**/*.txt'],
    path: 'a/dir/file.txt',
    excluded: true,
  },
  {
    name: 'matchesTestCase:158',
    patterns: ['a**/*.txt'],
    path: 'a/dir/dir/file.txt',
    excluded: true,
  },
  {
    name: 'matchesTestCase:159',
    patterns: ['a/*.txt'],
    path: 'a/dir/file.txt',
    excluded: false,
  },
  {
    name: 'matchesTestCase:160',
    patterns: ['a/*.txt'],
    path: 'a/file.txt',
    excluded: true,
  },
  {
    name: 'matchesTestCase:161',
    patterns: ['a/*.txt**'],
    path: 'a/file.txt',
    excluded: true,
  },
  {
    name: 'matchesTestCase:162',
    patterns: ['a[b-d]e'],
    path: 'ae',
    excluded: false,
  },
  {
    name: 'matchesTestCase:163',
    patterns: ['a[b-d]e'],
    path: 'ace',
    excluded: true,
  },
  {
    name: 'matchesTestCase:164',
    patterns: ['a[b-d]e'],
    path: 'aae',
    excluded: false,
  },
  {
    name: 'matchesTestCase:165',
    patterns: ['a[^b-d]e'],
    path: 'aze',
    excluded: true,
  },
  {
    name: 'matchesTestCase:166',
    patterns: ['.*'],
    path: '.foo',
    excluded: true,
  },
  {
    name: 'matchesTestCase:167',
    patterns: ['.*'],
    path: 'foo',
    excluded: false,
  },
  {
    name: 'matchesTestCase:168',
    patterns: ['abc.def'],
    path: 'abcdef',
    excluded: false,
  },
  {
    name: 'matchesTestCase:169',
    patterns: ['abc.def'],
    path: 'abc.def',
    excluded: true,
  },
  {
    name: 'matchesTestCase:170',
    patterns: ['abc.def'],
    path: 'abcZdef',
    excluded: false,
  },
  {
    name: 'matchesTestCase:171',
    patterns: ['abc?def'],
    path: 'abcZdef',
    excluded: true,
  },
  {
    name: 'matchesTestCase:172',
    patterns: ['abc?def'],
    path: 'abcdef',
    excluded: false,
  },
  {
    name: 'matchesTestCase:173',
    patterns: ['a\\\\'],
    path: 'a\\',
    excluded: true,
  },
  {
    name: 'matchesTestCase:174',
    patterns: ['**/foo/bar'],
    path: 'foo/bar',
    excluded: true,
  },
  {
    name: 'matchesTestCase:175',
    patterns: ['**/foo/bar'],
    path: 'dir/foo/bar',
    excluded: true,
  },
  {
    name: 'matchesTestCase:176',
    patterns: ['**/foo/bar'],
    path: 'dir/dir2/foo/bar',
    excluded: true,
  },
  {
    name: 'matchesTestCase:177',
    patterns: ['abc/**'],
    path: 'abc',
    excluded: false,
  },
  {
    name: 'matchesTestCase:178',
    patterns: ['abc/**'],
    path: 'abc/def',
    excluded: true,
  },
  {
    name: 'matchesTestCase:179',
    patterns: ['abc/**'],
    path: 'abc/def/ghi',
    excluded: true,
  },
  {
    name: 'matchesTestCase:180',
    patterns: ['**/.foo'],
    path: '.foo',
    excluded: true,
  },
  {
    name: 'matchesTestCase:181',
    patterns: ['**/.foo'],
    path: 'bar.foo',
    excluded: false,
  },
  {
    name: 'matchesTestCase:182',
    patterns: ['a(b)c/def'],
    path: 'a(b)c/def',
    excluded: true,
  },
  {
    name: 'matchesTestCase:183',
    patterns: ['a(b)c/def'],
    path: 'a(b)c/xyz',
    excluded: false,
  },
  {
    name: 'matchesTestCase:184',
    patterns: ['a.|)$(}+{bc'],
    path: 'a.|)$(}+{bc',
    excluded: true,
  },
  {
    name: 'matchesTestCase:185',
    patterns: ['dist/proxy.py-2.4.0rc3.dev36+g08acad9-py3-none-any.whl'],
    path: 'dist/proxy.py-2.4.0rc3.dev36+g08acad9-py3-none-any.whl',
    excluded: true,
  },
  {
    name: 'matchesTestCase:186',
    patterns: ['dist/*.whl'],
    path: 'dist/proxy.py-2.4.0rc3.dev36+g08acad9-py3-none-any.whl',
    excluded: true,
  },
  {
    name: 'multiPatternTestCase:189',
    patterns: ['**', '!util/docker/web'],
    path: 'util/docker/web/foo',
    excluded: false,
  },
  {
    name: 'multiPatternTestCase:190',
    patterns: ['**', '!util/docker/web', 'util/docker/web/foo'],
    path: 'util/docker/web/foo',
    excluded: true,
  },
  {
    name: 'multiPatternTestCase:191',
    patterns: ['**', '!dist/proxy.py-2.4.0rc3.dev36+g08acad9-py3-none-any.whl'],
    path: 'dist/proxy.py-2.4.0rc3.dev36+g08acad9-py3-none-any.whl',
    excluded: false,
  },
  {
    name: 'multiPatternTestCase:192',
    patterns: ['**', '!dist/*.whl'],
    path: 'dist/proxy.py-2.4.0rc3.dev36+g08acad9-py3-none-any.whl',
    excluded: false,
  },
  {
    name: 'matchesTestCase:197',
    patterns: ['a\\*b'],
    path: 'a*b',
    excluded: true,
  },
  { name: 'matchTest:391', patterns: ['abc'], path: 'abc', excluded: true },
  { name: 'matchTest:392', patterns: ['*'], path: 'abc', excluded: true },
  { name: 'matchTest:393', patterns: ['*c'], path: 'abc', excluded: true },
  { name: 'matchTest:394', patterns: ['a*'], path: 'a', excluded: true },
  { name: 'matchTest:395', patterns: ['a*'], path: 'abc', excluded: true },
  { name: 'matchTest:396', patterns: ['a*'], path: 'ab/c', excluded: true },
  { name: 'matchTest:397', patterns: ['a*/b'], path: 'abc/b', excluded: true },
  { name: 'matchTest:398', patterns: ['a*/b'], path: 'a/c/b', excluded: false },
  {
    name: 'matchTest:399',
    patterns: ['a*b*c*d*e*/f'],
    path: 'axbxcxdxe/f',
    excluded: true,
  },
  {
    name: 'matchTest:400',
    patterns: ['a*b*c*d*e*/f'],
    path: 'axbxcxdxexxx/f',
    excluded: true,
  },
  {
    name: 'matchTest:401',
    patterns: ['a*b*c*d*e*/f'],
    path: 'axbxcxdxe/xxx/f',
    excluded: false,
  },
  {
    name: 'matchTest:402',
    patterns: ['a*b*c*d*e*/f'],
    path: 'axbxcxdxexxx/fff',
    excluded: false,
  },
  {
    name: 'matchTest:403',
    patterns: ['a*b?c*x'],
    path: 'abxbbxdbxebxczzx',
    excluded: true,
  },
  {
    name: 'matchTest:404',
    patterns: ['a*b?c*x'],
    path: 'abxbbxdbxebxczzy',
    excluded: false,
  },
  { name: 'matchTest:405', patterns: ['ab[c]'], path: 'abc', excluded: true },
  { name: 'matchTest:406', patterns: ['ab[b-d]'], path: 'abc', excluded: true },
  {
    name: 'matchTest:407',
    patterns: ['ab[e-g]'],
    path: 'abc',
    excluded: false,
  },
  { name: 'matchTest:408', patterns: ['ab[^c]'], path: 'abc', excluded: false },
  {
    name: 'matchTest:409',
    patterns: ['ab[^b-d]'],
    path: 'abc',
    excluded: false,
  },
  {
    name: 'matchTest:410',
    patterns: ['ab[^e-g]'],
    path: 'abc',
    excluded: true,
  },
  { name: 'matchTest:411', patterns: ['a\\*b'], path: 'a*b', excluded: true },
  { name: 'matchTest:412', patterns: ['a\\*b'], path: 'ab', excluded: false },
  { name: 'matchTest:413', patterns: ['a?b'], path: 'a☺b', excluded: true },
  { name: 'matchTest:414', patterns: ['a[^a]b'], path: 'a☺b', excluded: true },
  { name: 'matchTest:415', patterns: ['a???b'], path: 'a☺b', excluded: false },
  {
    name: 'matchTest:416',
    patterns: ['a[^a][^a][^a]b'],
    path: 'a☺b',
    excluded: false,
  },
  { name: 'matchTest:417', patterns: ['[a-ζ]*'], path: 'α', excluded: true },
  { name: 'matchTest:418', patterns: ['*[a-ζ]'], path: 'A', excluded: false },
  { name: 'matchTest:419', patterns: ['a?b'], path: 'a/b', excluded: false },
  { name: 'matchTest:420', patterns: ['a*b'], path: 'a/b', excluded: false },
  { name: 'matchTest:421', patterns: ['[\\]a]'], path: ']', excluded: true },
  { name: 'matchTest:422', patterns: ['[\\-]'], path: '-', excluded: true },
  { name: 'matchTest:423', patterns: ['[x\\-]'], path: 'x', excluded: true },
  { name: 'matchTest:424', patterns: ['[x\\-]'], path: '-', excluded: true },
  { name: 'matchTest:425', patterns: ['[x\\-]'], path: 'z', excluded: false },
  { name: 'matchTest:426', patterns: ['[\\-x]'], path: 'x', excluded: true },
  { name: 'matchTest:427', patterns: ['[\\-x]'], path: '-', excluded: true },
  { name: 'matchTest:428', patterns: ['[\\-x]'], path: 'a', excluded: false },
  { name: 'matchTest:429', patterns: ['[]a]'], path: ']', excluded: 'error' },
  { name: 'matchTest:430', patterns: ['[-]'], path: '-', excluded: 'error' },
  { name: 'matchTest:431', patterns: ['[x-]'], path: 'x', excluded: 'error' },
  { name: 'matchTest:432', patterns: ['[x-]'], path: '-', excluded: 'error' },
  { name: 'matchTest:433', patterns: ['[x-]'], path: 'z', excluded: 'error' },
  { name: 'matchTest:434', patterns: ['[-x]'], path: 'x', excluded: 'error' },
  { name: 'matchTest:435', patterns: ['[-x]'], path: '-', excluded: 'error' },
  { name: 'matchTest:436', patterns: ['[-x]'], path: 'a', excluded: 'error' },
  { name: 'matchTest:437', patterns: ['\\'], path: 'a', excluded: 'error' },
  {
    name: 'matchTest:438',
    patterns: ['[a-b-c]'],
    path: 'a',
    excluded: 'error',
  },
  { name: 'matchTest:439', patterns: ['['], path: 'a', excluded: 'error' },
  { name: 'matchTest:440', patterns: ['[^'], path: 'a', excluded: 'error' },
  { name: 'matchTest:441', patterns: ['[^bc'], path: 'a', excluded: 'error' },
  { name: 'matchTest:442', patterns: ['a['], path: 'a', excluded: 'error' },
  { name: 'matchTest:443', patterns: ['a['], path: 'ab', excluded: 'error' },
  { name: 'matchTest:444', patterns: ['*x'], path: 'xxx', excluded: true },
  {
    name: 'TestWildcardMatches',
    patterns: ['*'],
    path: 'fileutils.go',
    excluded: true,
  },
  {
    name: 'TestPatternMatches',
    patterns: ['*.go'],
    path: 'fileutils.go',
    excluded: true,
  },
  {
    name: 'TestExclusionPatternMatchesPatternBefore',
    patterns: ['!fileutils.go', '*.go'],
    path: 'fileutils.go',
    excluded: true,
  },
  {
    name: 'TestPatternMatchesFolderExclusions',
    patterns: ['docs', '!docs/README.md'],
    path: 'docs/README.md',
    excluded: false,
  },
  {
    name: 'TestPatternMatchesFolderWithSlashExclusions',
    patterns: ['docs/', '!docs/README.md'],
    path: 'docs/README.md',
    excluded: false,
  },
  {
    name: 'TestPatternMatchesFolderWildcardExclusions',
    patterns: ['docs/*', '!docs/README.md'],
    path: 'docs/README.md',
    excluded: false,
  },
  {
    name: 'TestExclusionPatternMatchesPatternAfter',
    patterns: ['*.go', '!fileutils.go'],
    path: 'fileutils.go',
    excluded: false,
  },
  {
    name: 'TestExclusionPatternMatchesWholeDirectory',
    patterns: ['*.go'],
    path: '.',
    excluded: false,
  },
  {
    name: 'TestSingleExclamationError',
    patterns: ['!'],
    path: 'fileutils.go',
    excluded: 'error',
  },
  {
    name: 'TestMatchesWithNoPatterns',
    patterns: [],
    path: '/any/path/there',
    excluded: false,
  },
  {
    name: 'TestMatchesWithMalformedPatterns',
    patterns: ['['],
    path: '/any/path/there',
    excluded: 'error',
  },
];

interface CompileCase {
  pattern: string;
  kind: 'exact' | 'prefix' | 'suffix' | 'regexp';
  /** The regexp of Go with "/" and with "\\" as the separator. */
  slash?: string;
  backslash?: string;
}

/** compileTests of patternmatcher_test.go at v0.6.1 (lines 481-503). */
const COMPILE_CASES: CompileCase[] = [
  {
    pattern: '*',
    kind: 'regexp',
    slash: String.raw`^[^/]*$`,
    backslash: String.raw`^[^\\]*$`,
  },
  {
    pattern: 'file*',
    kind: 'regexp',
    slash: String.raw`^file[^/]*$`,
    backslash: String.raw`^file[^\\]*$`,
  },
  {
    pattern: '*file',
    kind: 'regexp',
    slash: String.raw`^[^/]*file$`,
    backslash: String.raw`^[^\\]*file$`,
  },
  {
    pattern: 'a*/b',
    kind: 'regexp',
    slash: String.raw`^a[^/]*/b$`,
    backslash: String.raw`^a[^\\]*\\b$`,
  },
  { pattern: '**', kind: 'suffix' },
  {
    pattern: '**/**',
    kind: 'regexp',
    slash: String.raw`^(.*/)?.*$`,
    backslash: String.raw`^(.*\\)?.*$`,
  },
  { pattern: 'dir/**', kind: 'prefix' },
  { pattern: '**/dir', kind: 'suffix' },
  {
    pattern: '**/dir2/*',
    kind: 'regexp',
    slash: String.raw`^(.*/)?dir2/[^/]*$`,
    backslash: String.raw`^(.*\\)?dir2\\[^\\]*$`,
  },
  {
    pattern: '**/dir2/**',
    kind: 'regexp',
    slash: String.raw`^(.*/)?dir2/.*$`,
    backslash: String.raw`^(.*\\)?dir2\\.*$`,
  },
  { pattern: '**file', kind: 'suffix' },
  {
    pattern: '**/file*txt',
    kind: 'regexp',
    slash: String.raw`^(.*/)?file[^/]*txt$`,
    backslash: String.raw`^(.*\\)?file[^\\]*txt$`,
  },
  {
    pattern: '**/**/*.txt',
    kind: 'regexp',
    slash: String.raw`^(.*/)?(.*/)?[^/]*\.txt$`,
    backslash: String.raw`^(.*\\)?(.*\\)?[^\\]*\.txt$`,
  },
  {
    pattern: 'a[b-d]e',
    kind: 'regexp',
    slash: String.raw`^a[b-d]e$`,
    backslash: String.raw`^a[b-d]e$`,
  },
  {
    pattern: '.*',
    kind: 'regexp',
    slash: String.raw`^\.[^/]*$`,
    backslash: String.raw`^\.[^\\]*$`,
  },
  { pattern: 'abc.def', kind: 'exact' },
  {
    pattern: 'abc?def',
    kind: 'regexp',
    slash: String.raw`^abc[^/]def$`,
    backslash: String.raw`^abc[^\\]def$`,
  },
  { pattern: '**/foo/bar', kind: 'suffix' },
  { pattern: 'a(b)c/def', kind: 'exact' },
  { pattern: 'a.|)$(}+{bc', kind: 'exact' },
  {
    pattern: 'dist/proxy.py-2.4.0rc3.dev36+g08acad9-py3-none-any.whl',
    kind: 'exact',
  },
];

/** The files of each folder of the tree cases; the Docker CLI ran on each. */
const TREE = [
  'C++/main.cpp',
  'Dockerfile',
  'a+b.txt',
  'abs/path',
  'app.log',
  'bar/y',
  'build/out.js',
  'docs/README.md',
  'docs/guide.md',
  'dot/x',
  'file (1).txt',
  'important.log',
  'node_modules/pkg/index.js',
  'src/a.tmp',
  'src/build/keep.js',
  'src/deep/b.tmp',
  'src/main.test.ts',
  'src/main.ts',
  'src/sub/x.test.ts',
  'util/docker/web/foo',
  'util/other',
];

interface TreeCase {
  name: string;
  dockerignore: string;
  /** The tar entries of the Docker CLI's ReadDockerignore, TrimBuildFilesFromExcludes and TarWithOptions, sorted. */
  sent: string[];
}

const TREE_CASES: TreeCase[] = [
  {
    name: 'A: exclusions, a rooted pattern and **',
    dockerignore: 'node_modules\n*.log\n!important.log\n/build\n**/*.tmp\n',
    sent: [
      '.dockerignore',
      'C++',
      'C++/main.cpp',
      'Dockerfile',
      'a+b.txt',
      'abs',
      'abs/path',
      'bar',
      'bar/y',
      'docs',
      'docs/README.md',
      'docs/guide.md',
      'dot',
      'dot/x',
      'file (1).txt',
      'important.log',
      'src',
      'src/build',
      'src/build/keep.js',
      'src/deep',
      'src/main.test.ts',
      'src/main.ts',
      'src/sub',
      'src/sub/x.test.ts',
      'util',
      'util/docker',
      'util/docker/web',
      'util/docker/web/foo',
      'util/other',
    ],
  },
  {
    name: 'B: * with an exception for a folder',
    dockerignore: '*\n!src\n!Dockerfile\nsrc/**/*.test.ts\n',
    sent: [
      '.dockerignore',
      'Dockerfile',
      'src',
      'src/a.tmp',
      'src/build',
      'src/build/keep.js',
      'src/deep',
      'src/deep/b.tmp',
      'src/main.ts',
      'src/sub',
    ],
  },
  {
    name: 'C: a folder with an exception, a comment, spaces, ./ and ..',
    dockerignore:
      'docs\n!docs/README.md\n# comment\n  /abs/path  \n./dot/x\nfoo/../bar\n',
    sent: [
      '.dockerignore',
      'C++',
      'C++/main.cpp',
      'Dockerfile',
      'a+b.txt',
      'abs',
      'app.log',
      'build',
      'build/out.js',
      'docs/README.md',
      'dot',
      'file (1).txt',
      'important.log',
      'node_modules',
      'node_modules/pkg',
      'node_modules/pkg/index.js',
      'src',
      'src/a.tmp',
      'src/build',
      'src/build/keep.js',
      'src/deep',
      'src/deep/b.tmp',
      'src/main.test.ts',
      'src/main.ts',
      'src/sub',
      'src/sub/x.test.ts',
      'util',
      'util/docker',
      'util/docker/web',
      'util/docker/web/foo',
      'util/other',
    ],
  },
  {
    name: 'D: names with +, ( and )',
    dockerignore: 'C++\nfile (1).txt\na+b.txt\n',
    sent: [
      '.dockerignore',
      'Dockerfile',
      'abs',
      'abs/path',
      'app.log',
      'bar',
      'bar/y',
      'build',
      'build/out.js',
      'docs',
      'docs/README.md',
      'docs/guide.md',
      'dot',
      'dot/x',
      'important.log',
      'node_modules',
      'node_modules/pkg',
      'node_modules/pkg/index.js',
      'src',
      'src/a.tmp',
      'src/build',
      'src/build/keep.js',
      'src/deep',
      'src/deep/b.tmp',
      'src/main.test.ts',
      'src/main.ts',
      'src/sub',
      'src/sub/x.test.ts',
      'util',
      'util/docker',
      'util/docker/web',
      'util/docker/web/foo',
      'util/other',
    ],
  },
  {
    name: 'E: the Dockerfile and .dockerignore excluded',
    dockerignore: '.dockerignore\nDockerfile\n',
    sent: [
      '.dockerignore',
      'C++',
      'C++/main.cpp',
      'Dockerfile',
      'a+b.txt',
      'abs',
      'abs/path',
      'app.log',
      'bar',
      'bar/y',
      'build',
      'build/out.js',
      'docs',
      'docs/README.md',
      'docs/guide.md',
      'dot',
      'dot/x',
      'file (1).txt',
      'important.log',
      'node_modules',
      'node_modules/pkg',
      'node_modules/pkg/index.js',
      'src',
      'src/a.tmp',
      'src/build',
      'src/build/keep.js',
      'src/deep',
      'src/deep/b.tmp',
      'src/main.test.ts',
      'src/main.ts',
      'src/sub',
      'src/sub/x.test.ts',
      'util',
      'util/docker',
      'util/docker/web',
      'util/docker/web/foo',
      'util/other',
    ],
  },
  {
    name: 'F: ** with an exception deep in the tree',
    dockerignore: '**\n!util/docker/web\n',
    sent: [
      '.dockerignore',
      'Dockerfile',
      'util/docker/web',
      'util/docker/web/foo',
    ],
  },
];

/**
 * The cases that patternmatcher_test.go leaves out on Windows, where "\" is a
 * separator and escapes nothing: lines 195-199 and 459-463.
 */
function goSkipsOnWindows({ name, patterns }: PatternCase): string | false {
  if (process.platform !== 'win32') return false;
  if (name === 'matchesTestCase:197') {
    return 'Go adds this case only off Windows';
  }
  if (
    name.startsWith('matchTest:') &&
    patterns.some((pattern) => pattern.includes('\\'))
  ) {
    return 'no escape allowed on windows';
  }
  return false;
}

/** A folder with the files of TREE and a .dockerignore of `dockerignore`. */
async function writeTree(root: string, dockerignore: string): Promise<void> {
  for (const file of TREE) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), `${file}\n`);
  }
  await writeFile(join(root, '.dockerignore'), dockerignore);
}

describe('the .dockerignore rules of the Docker CLI', () => {
  void test.each(PATTERN_CASES, (patternCase) => {
    const { name, patterns, path, excluded } = patternCase;
    return test(
      `${name}: ${JSON.stringify(patterns)} and ${JSON.stringify(path)}`,
      { skip: goSkipsOnWindows(patternCase) },
      () => {
        // Act
        const act = () => matches(path, patterns);

        // Assert
        if (excluded === 'error') {
          assert.throws(act, SyntaxError);
        } else {
          assert.equal(act(), excluded);
        }
      },
    );
  });

  void test.each(['/', '\\'] as const, (separator) =>
    test.each(COMPILE_CASES, ({ pattern, kind, slash, backslash }) =>
      test(`TestCompile with ${separator}: ${pattern}`, () => {
        // Arrange: as testCompile, a cleaned pattern with the separator.
        const cleaned = posix.normalize(pattern).replaceAll('/', separator);

        // Act
        const compiled = compile(cleaned, separator);

        // Assert
        assert.equal(compiled.kind, kind);
        if (compiled.kind === 'regexp') {
          assert.equal(compiled.source, separator === '/' ? slash : backslash);
        }
      }),
    ),
  );

  test('TestCleanPatterns and TestCleanPatternsStripEmptyPatterns: the patterns are read and a blank one is dropped', () => {
    // Act and Assert
    assert.equal(matches('config', ['docs', 'config', '']), true);
    assert.equal(matches('other', ['docs', 'config', '']), false);
  });

  void test.each(
    ['!docs/README.md', '  !docs/README.md', '!docs/README.md  '],
    (exception) =>
      test(`TestCleanPatterns: ${JSON.stringify(exception)} is an exception`, () => {
        // Act and Assert
        assert.equal(matches('docs/README.md', ['docs', exception]), false);
        assert.equal(matches('docs/guide.md', ['docs', exception]), true);
      }),
  );

  test('TestMatchesOrParentMatchesMalformedPatternDoesNotPanicOnRepeatedCall: a pattern that passes the check and does not compile fails at each match', () => {
    // Act and Assert
    assert.throws(() => matches('x', ['[Local-Only]/']), SyntaxError);
    assert.throws(() => matches('x', ['[Local-Only]/']), SyntaxError);
  });

  test('ignorefile_test.go TestReadAll: a .dockerignore drops comments and blank lines, trims and cleans each pattern, and drops a leading /', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    await writeFile(
      join(scratch.path, '.dockerignore'),
      'test1\n/test2\n/a/file/here\n\nlastfile\n# this is a comment\n! /inverted/abs/path\n!\n! ',
    );

    // Act
    const patterns = await readDockerignore(scratch.path);

    // Assert
    assert.deepEqual(patterns, [
      'test1',
      'test2',
      'a/file/here',
      'lastfile',
      '!inverted/abs/path',
      '!',
      '!',
    ]);
  });

  test('a folder with no .dockerignore has no patterns', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');

    // Act
    const patterns = await readDockerignore(scratch.path);

    // Assert
    assert.deepEqual(patterns, []);
  });

  void test.each(TREE_CASES, ({ name, dockerignore, sent }) =>
    test(`the context sends what the Docker CLI sends, ${name}`, async () => {
      // Arrange
      await using scratch = await new TemporaryFiles().directory(
        'docker-test-',
      );
      await writeTree(scratch.path, dockerignore);

      // Act
      const paths = await Array.fromAsync(
        contextPaths(scratch.path, 'Dockerfile'),
      );

      // Assert
      assert.deepEqual(paths.toSorted(), sent);
    }),
  );

  void test.each(
    [
      [String.raw`\d`, '1'],
      [String.raw`\pL`, 'x'],
      ['[[:alpha:]]', 'x'],
    ] as const,
    ([pattern, path]) =>
      test(
        `a pattern with the regexp syntax ${pattern} of Go, which Go excludes ${path} with, is malformed`,
        { skip: pattern.includes('\\') && process.platform === 'win32' },
        () => {
          // Act and Assert
          assert.throws(() => matches(path, [pattern]), SyntaxError);
        },
      ),
  );

  // Go's MatchesOrParentMatches: "." of Go's regexp skips only "\n".
  void test.each(
    [
      ['a/x\ny/b', false],
      ['a/x\ry/b', true],
      ['a/x\u{2028}y/b', true],
    ] as const,
    ([path, excluded]) =>
      test(`a/**/b and ${JSON.stringify(path)}`, () => {
        // Act and Assert
        assert.equal(matches(path, ['a/**/b']), excluded);
      }),
  );

  test('a pattern that fails to compile stops the context, where Go sends the part it has', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    await writeFile(join(scratch.path, 'Dockerfile'), 'FROM scratch\n');
    await writeFile(join(scratch.path, '.dockerignore'), '[z-a]\n');

    // Act
    const paths = Array.fromAsync(contextPaths(scratch.path, 'Dockerfile'));

    // Assert
    await assert.rejects(paths, SyntaxError);
  });

  // Each value is what Go's ignorefile.ReadAll gives for the same bytes.
  void test.each(
    [
      {
        name: 'a line ends at \\n and a \\r before it goes',
        text: 'foo\r\nbar \r\n#c\r\n!baz\r\n\r\n',
        patterns: ['foo', 'bar', '!baz'],
      },
      {
        name: 'a byte order mark at the start goes',
        text: '\u{FEFF}foo\nbar\n',
        patterns: ['foo', 'bar'],
      },
      {
        name: 'a comment can follow the byte order mark',
        text: '\u{FEFF}#comment\nbar\n',
        patterns: ['bar'],
      },
      {
        name: 'a line is a comment only when "#" is its first character',
        text: ' #x\n# y\n\t#z\n',
        patterns: ['#x', '#z'],
      },
      {
        name: 'U+FEFF is not a space to trim',
        text: 'a\n\u{FEFF}foo\nbar\u{FEFF}\n! \u{FEFF}baz\n',
        patterns: ['a', '\u{FEFF}foo', 'bar\u{FEFF}', '!\u{FEFF}baz'],
      },
    ],
    ({ name, text, patterns }) =>
      test(`readDockerignore: ${name}`, async () => {
        // Arrange
        await using scratch = await new TemporaryFiles().directory(
          'docker-test-',
        );
        await writeFile(join(scratch.path, '.dockerignore'), text);

        // Act
        const read = await readDockerignore(scratch.path);

        // Assert
        assert.deepEqual(read, patterns);
      }),
  );

  // Each `sent` is the tar entries of the Docker CLI's path for the same folder.
  test('a Dockerfile in an excluded folder is sent, and no other file of the folder', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    await mkdir(join(scratch.path, 'sub/dir'), { recursive: true });
    for (const file of [
      'sub/dir/Dockerfile',
      'sub/dir/other',
      'sub/x',
      'keep',
    ]) {
      await writeFile(join(scratch.path, file), `${file}\n`);
    }
    await writeFile(join(scratch.path, '.dockerignore'), 'sub\n');

    // Act
    const paths = await Array.fromAsync(
      contextPaths(scratch.path, 'sub/dir/Dockerfile'),
    );

    // Assert
    assert.deepEqual(paths.toSorted(), [
      '.dockerignore',
      'keep',
      'sub/dir/Dockerfile',
    ]);
  });

  test('an exception for a Dockerfile in an excluded folder sends it once', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    await mkdir(join(scratch.path, 'sub/dir'), { recursive: true });
    for (const file of [
      'sub/dir/Dockerfile',
      'sub/dir/other',
      'sub/x',
      'keep',
    ]) {
      await writeFile(join(scratch.path, file), `${file}\n`);
    }
    await writeFile(
      join(scratch.path, '.dockerignore'),
      'sub\n!sub/dir/Dockerfile\n',
    );

    // Act
    const paths = await Array.fromAsync(
      contextPaths(scratch.path, 'sub/dir/Dockerfile'),
    );

    // Assert
    assert.deepEqual(paths.toSorted(), [
      '.dockerignore',
      'keep',
      'sub/dir/Dockerfile',
    ]);
  });

  test('a pattern deeper than the folder of the Dockerfile does not keep it, as the deprecated Matches of Go reads one parent', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    await mkdir(join(scratch.path, 'x'));
    for (const file of ['x/Dockerfile', 'x/other', 'keep']) {
      await writeFile(join(scratch.path, file), `${file}\n`);
    }
    await writeFile(join(scratch.path, '.dockerignore'), '**/x\n');

    // Act
    const paths = await Array.fromAsync(
      contextPaths(scratch.path, 'x/Dockerfile'),
    );

    // Assert
    assert.deepEqual(paths.toSorted(), ['.dockerignore', 'keep']);
  });

  test('a symbolic link to a file or a folder is sent and not followed', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    await mkdir(join(scratch.path, 'real'));
    for (const file of ['Dockerfile', 'real/f', 'target']) {
      await writeFile(join(scratch.path, file), `${file}\n`);
    }
    await symlink('target', join(scratch.path, 'link-file'), 'file');
    await symlink('real', join(scratch.path, 'link-dir'), 'dir');
    await writeFile(join(scratch.path, '.dockerignore'), 'real\n');

    // Act
    const paths = await Array.fromAsync(
      contextPaths(scratch.path, 'Dockerfile'),
    );

    // Assert
    assert.deepEqual(paths.toSorted(), [
      '.dockerignore',
      'Dockerfile',
      'link-dir',
      'link-file',
      'target',
    ]);
  });

  test('an empty folder is sent', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    await mkdir(join(scratch.path, 'empty'));
    await mkdir(join(scratch.path, 'a/empty'), { recursive: true });
    for (const file of ['Dockerfile', 'a.log']) {
      await writeFile(join(scratch.path, file), `${file}\n`);
    }
    await writeFile(join(scratch.path, '.dockerignore'), '*.log\n');

    // Act
    const paths = await Array.fromAsync(
      contextPaths(scratch.path, 'Dockerfile'),
    );

    // Assert
    assert.deepEqual(paths.toSorted(), [
      '.dockerignore',
      'Dockerfile',
      'a',
      'a/empty',
      'empty',
    ]);
  });

  test('an exception two folders deep in an excluded folder sends only its own path', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    await mkdir(join(scratch.path, 'a/b/c'), { recursive: true });
    for (const file of ['Dockerfile', 'a/x', 'a/b/y', 'a/b/c/d', 'a/b/cc']) {
      await writeFile(join(scratch.path, file), `${file}\n`);
    }
    await writeFile(join(scratch.path, '.dockerignore'), 'a\n!a/b/c\n');

    // Act
    const paths = await Array.fromAsync(
      contextPaths(scratch.path, 'Dockerfile'),
    );

    // Assert
    assert.deepEqual(paths.toSorted(), [
      '.dockerignore',
      'Dockerfile',
      'a/b/c',
      'a/b/c/d',
    ]);
  });

  test('in an excluded folder, a pattern is matched against the path and not again against the folder', async () => {
    // Arrange: the folder a skips the last "a", as "a" already excluded it.
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    await mkdir(join(scratch.path, 'a'));
    for (const file of ['Dockerfile', 'a/b', 'a/c']) {
      await writeFile(join(scratch.path, file), `${file}\n`);
    }
    await writeFile(join(scratch.path, '.dockerignore'), 'a\n!a/b\na\n');

    // Act
    const paths = await Array.fromAsync(
      contextPaths(scratch.path, 'Dockerfile'),
    );

    // Assert
    assert.deepEqual(paths.toSorted(), ['.dockerignore', 'Dockerfile', 'a/b']);
  });
});
