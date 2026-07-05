const axios = require('axios');

const VENDOR_TOOLS_URL = 'https://vendortools.net/database/pokemon-japan/expansions';

function parseVendorToolsLine(line) {
  const match = line.match(/^-\s*([A-Z0-9]+)_JA(.+?)Pokemon Japan/i);
  if (!match) {
    const alt = line.match(/^-\s*([A-Z0-9]+)(?:_JA)?([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})(.+?)Pokemon Japan/i);
    if (!alt) return null;
    return {
      setCode: alt[1],
      setName: alt[3].trim(),
    };
  }

  const setCode = match[1];
  const rest = match[2];
  const nameMatch = rest.match(/(?:[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})(.+)/);
  const setName = nameMatch ? nameMatch[1].trim() : rest.trim();

  return { setCode, setName };
}

async function fetchVendorToolsSets() {
  const response = await axios.get(VENDOR_TOOLS_URL, {
    timeout: 30000,
    headers: { 'User-Agent': 'automation-tcg/1.0' },
  });

  const html = String(response.data);
  const sets = [];
  const pattern = /font-mono">([A-Z0-9]+)_JA<\/span>[\s\S]*?font-semibold leading-snug text-foreground[^>]*>([^<]+)</g;

  for (const match of html.matchAll(pattern)) {
    sets.push({
      setCode: match[1],
      setName: match[2].trim(),
    });
  }

  if (sets.length) {
    return sets;
  }

  const lines = html.split('\n');
  for (const line of lines) {
    const parsed = parseVendorToolsLine(line.trim());
    if (parsed?.setCode && parsed?.setName) {
      sets.push(parsed);
    }
  }

  return sets;
}

module.exports = {
  fetchVendorToolsSets,
  parseVendorToolsLine,
};
