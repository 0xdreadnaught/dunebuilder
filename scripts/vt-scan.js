'use strict';

/**
 * VirusTotal scan script for DuneBuilder portable exe.
 *
 * Usage:
 *   VT_API_KEY=<your-key> node scripts/vt-scan.js [path-to-exe]
 *
 * If no path is given, it finds the portable exe in dist/.
 * Uploads the file, polls for results, then writes a report file
 * next to the exe (e.g. DuneBuilder-0.0.1.exe.vt-report.txt).
 *
 * Free-tier limits: 4 req/min, 500/day — the script rate-limits itself.
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

const keyFile = path.join(__dirname, '..', 'vt.key');
let API_KEY = process.env.VT_API_KEY;
if (!API_KEY && fs.existsSync(keyFile)) {
  API_KEY = fs.readFileSync(keyFile, 'utf-8').trim();
}
if (!API_KEY) {
  console.error('Error: No API key found. Either:');
  console.error('  1. Create a vt.key file in the project root with your key');
  console.error('  2. Set VT_API_KEY environment variable');
  console.error('Get a free key at: https://www.virustotal.com/gui/my-apikey');
  process.exit(1);
}

function findExe(dir) {
  if (!fs.existsSync(dir)) return null;
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  const expected = `DuneBuilder-${pkg.version}.exe`;
  if (fs.existsSync(path.join(dir, expected))) return expected;
  // Fallback: pick the newest DuneBuilder exe
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.exe') && f.startsWith('DuneBuilder'))
    .sort()
    .reverse();
  return files[0] || null;
}

function request(method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, 'https://www.virustotal.com');
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: { 'x-apikey': API_KEY, ...headers },
    };

    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode, data: text }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function uploadFile(filePath) {
  const fileName = path.basename(filePath);
  const fileData = fs.readFileSync(filePath);
  const boundary = '----VTBoundary' + Date.now();

  const preamble = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([preamble, fileData, epilogue]);

  console.log(`Uploading ${fileName} (${(fileData.length / 1024 / 1024).toFixed(1)} MB)...`);

  // Files > 32MB need the upload URL endpoint; portable exes are typically > 32MB
  let uploadUrl = 'https://www.virustotal.com/api/v3/files';
  if (fileData.length > 32 * 1024 * 1024) {
    console.log('File > 32MB, requesting large-file upload URL...');
    const urlRes = await request('GET', '/api/v3/files/upload_url', {});
    if (urlRes.status !== 200) {
      throw new Error(`Failed to get upload URL: ${urlRes.status} ${JSON.stringify(urlRes.data)}`);
    }
    uploadUrl = urlRes.data.data;
    console.log('Got upload URL.');
  }

  const url = new URL(uploadUrl);
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'x-apikey': API_KEY,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode, data: text }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function pollAnalysis(analysisId) {
  const maxAttempts = 60; // 10 minutes max (10s intervals)
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(10000);
    const res = await request('GET', `/api/v3/analyses/${analysisId}`, {});
    if (res.status !== 200) {
      console.log(`  Poll returned ${res.status}, retrying...`);
      continue;
    }
    const status = res.data?.data?.attributes?.status;
    process.stdout.write(`\r  Scan status: ${status} (attempt ${i + 1}/${maxAttempts})`);
    if (status === 'completed') {
      console.log();
      return res.data;
    }
  }
  throw new Error('Scan timed out after 10 minutes');
}

function formatReport(analysis, filePath, permalink) {
  const attrs = analysis.data.attributes;
  const stats = attrs.stats;
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  const lines = [
    '==========================================================',
    'DUNEBUILDER — VirusTotal Scan Report',
    '==========================================================',
    '',
    `File:         ${path.basename(filePath)}`,
    `Scan date:    ${new Date().toISOString()}`,
    `Permalink:    ${permalink}`,
    '',
    `Results:      ${stats.malicious || 0} malicious, ${stats.suspicious || 0} suspicious out of ${total} engines`,
    `Undetected:   ${stats.undetected || 0}`,
    `Harmless:     ${stats.harmless || 0}`,
    '',
  ];

  // List any detections
  const results = attrs.results || {};
  const detections = Object.entries(results).filter(
    ([, r]) => r.category === 'malicious' || r.category === 'suspicious'
  );
  if (detections.length > 0) {
    lines.push('Detections:');
    detections.forEach(([engine, r]) => {
      lines.push(`  ${engine}: ${r.result} (${r.category})`);
    });
  } else {
    lines.push('No detections — all clean.');
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const distDir = path.join(__dirname, '..', 'dist');
  let exePath = process.argv[2];

  if (!exePath) {
    const exeName = findExe(distDir);
    if (!exeName) {
      console.error('No exe found in dist/. Run "npm run build" first.');
      process.exit(1);
    }
    exePath = path.join(distDir, exeName);
  }

  if (!fs.existsSync(exePath)) {
    console.error(`File not found: ${exePath}`);
    process.exit(1);
  }

  // Upload
  const uploadRes = await uploadFile(exePath);
  if (uploadRes.status !== 200) {
    console.error('Upload failed:', uploadRes.status, uploadRes.data);
    process.exit(1);
  }

  const analysisId = uploadRes.data?.data?.id;
  if (!analysisId) {
    console.error('No analysis ID returned:', uploadRes.data);
    process.exit(1);
  }
  console.log(`Upload complete. Analysis ID: ${analysisId}`);

  // Poll for results
  console.log('Waiting for scan results...');
  const analysis = await pollAnalysis(analysisId);

  // Compute SHA256 locally for a working permalink
  const fileBuffer = fs.readFileSync(exePath);
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const permalink = `https://www.virustotal.com/gui/file/${sha256}`;

  // Write report
  const report = formatReport(analysis, exePath, permalink);
  const reportPath = exePath + '.vt-report.txt';
  fs.writeFileSync(reportPath, report, 'utf-8');

  console.log('\n' + report);
  console.log(`Report saved to: ${reportPath}`);

  // Exit with error if malicious detections found
  const stats = analysis.data.attributes.stats;
  if ((stats.malicious || 0) > 0) {
    console.error('WARNING: Malicious detections found!');
    process.exit(2);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
