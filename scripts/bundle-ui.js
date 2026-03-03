const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '../src/ui/dashboard.html');
const destDir = path.join(__dirname, '../dist/ui');
const dest = path.join(destDir, 'dashboard.html');

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);

console.log('✅ UI bundled: dist/ui/dashboard.html');
