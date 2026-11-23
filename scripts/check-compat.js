import fs from 'fs';
import path from 'path';

const distDir = path.resolve('dist');

if (!fs.existsSync(distDir)) {
  console.error('Error: dist directory does not exist. Run build first.');
  process.exit(1);
}

const forbiddenPatterns = [
  'color-mix(',
  'oklch(',
  'oklab(',
  '@property',
  '@layer properties',
];

function getAllFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      getAllFiles(fullPath, fileList);
    } else {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

const allDistFiles = getAllFiles(distDir);
let totalViolations = 0;
const violationsReport = [];

for (const file of allDistFiles) {
  // Only check text-like assets (css, js, html, svg)
  const ext = path.extname(file).toLowerCase();
  if (!['.css', '.js', '.html', '.svg', '.txt', '.json', '.map'].includes(ext)) {
    continue;
  }

  const content = fs.readFileSync(file, 'utf8');

  for (const pattern of forbiddenPatterns) {
    let index = 0;
    while ((index = content.indexOf(pattern, index)) !== -1) {
      totalViolations++;
      const snippet = content.slice(Math.max(0, index - 30), Math.min(content.length, index + 70));
      violationsReport.push({
        file: path.relative(process.cwd(), file),
        pattern,
        snippet: snippet.replace(/\r?\n/g, ' '),
      });
      index += pattern.length;
    }
  }
}

if (totalViolations > 0) {
  console.error(`\x1b[31m[COMPAT CHECK FAILED] Found ${totalViolations} forbidden patterns in dist/:\x1b[0m`);
  for (const v of violationsReport) {
    console.error(` - [${v.pattern}] in ${v.file}: "...${v.snippet}..."`);
  }
  process.exit(1);
} else {
  console.log(`\x1b[32m[COMPAT CHECK PASSED] 0 forbidden patterns found across ${allDistFiles.length} files in dist/ (Chrome 108 & Firefox 115 compatible).\x1b[0m`);
  process.exit(0);
}
