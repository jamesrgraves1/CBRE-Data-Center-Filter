exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured on server.' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body.' }) };
  }

  const { street, city, state, county, zip, acres, apn } = body;

  if (!street || !city || !state) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Street, city, and state are required.' }) };
  }

  const addr = [street, city, state, zip].filter(Boolean).join(', ');
  const loc  = [county || city, state].filter(Boolean).join(', ');

  const prompt = `Analyze this property for data center suitability and return a JSON report.
Property: ${addr}
County: ${county || 'infer from city/state'}
Acreage: ${acres || 'not provided'}
APN: ${apn || 'not provided'}

Return ONLY this JSON structure filled in (no markdown, no backticks, no extra text):
{"geocoded_address":"${addr}","coordinates":"est lat,lng","county":"","state_abbr":"","score":0,"verdict":"","summary":"","checks":[{"id":"power_grid","category":"Power Infrastructure","name":"Power grid & transmission","status":"","pts":0,"max":20,"finding":"","url":"https://www.ercot.com/gridinfo","url_label":"Grid data"},{"id":"substation","category":"Power Infrastructure","name":"Substation proximity","status":"","pts":0,"max":15,"finding":"","url":"https://www.ferc.gov/industries-data/electric","url_label":"FERC data"},{"id":"fiber","category":"Connectivity","name":"Fiber & broadband","status":"","pts":0,"max":10,"finding":"","url":"https://broadbandmap.fcc.gov","url_label":"FCC Map"},{"id":"faa","category":"Connectivity","name":"FAA airspace","status":"","pts":0,"max":5,"finding":"","url":"https://oeaaa.faa.gov/oeaaa/external/portal.jsp","url_label":"FAA tool"},{"id":"dot","category":"Connectivity","name":"DOT rail & freight","status":"","pts":0,"max":0,"finding":"","url":"https://www.bts.gov/geospatial","url_label":"BTS map"},{"id":"fema","category":"Environmental & Hazards","name":"FEMA flood zone","status":"","pts":0,"max":12,"finding":"","url":"https://msc.fema.gov","url_label":"FEMA Map"},{"id":"elevation","category":"Environmental & Hazards","name":"USGS elevation & terrain","status":"","pts":0,"max":5,"finding":"","url":"https://apps.nationalmap.gov/epqs/","url_label":"USGS EPQS"},{"id":"epa","category":"Environmental & Hazards","name":"EPA environmental records","status":"","pts":0,"max":5,"finding":"","url":"https://echo.epa.gov","url_label":"EPA ECHO"},{"id":"wetlands","category":"Environmental & Hazards","name":"USFWS wetlands","status":"","pts":0,"max":8,"finding":"","url":"https://www.fws.gov/program/national-wetlands-inventory/wetlands-mapper","url_label":"NWI Mapper"},{"id":"acreage","category":"Site & Zoning","name":"Site acreage & scale","status":"","pts":0,"max":15,"finding":"","url":"https://www.tdcaa.com/resources/county-websites/","url_label":"County CAD"},{"id":"zoning","category":"Site & Zoning","name":"Zoning & land use","status":"","pts":0,"max":10,"finding":"","url":"https://www.planning.org/knowledgebase/gis/","url_label":"Local GIS"},{"id":"water","category":"Site & Zoning","name":"Municipal water","status":"","pts":0,"max":5,"finding":"","url":"https://www.epa.gov/waterdata/waters-geoviewer","url_label":"EPA Water"}]}

Rules: score=0-100, verdict="Likely Qualified"(70+)|"Needs Further Review"(40-69)|"Does Not Qualify"(<40), summary=2-3 sentences for CBRE analyst naming top strength and risk, status="pass"|"caution"|"flag"|"unknown", pts=integer in range, finding=1-2 sentences specific to ${loc} naming real utilities/airports/rail lines max 160 chars.
power_grid: name actual utility(Oncor/AEP/Dominion/etc), ISO(ERCOT/MISO/PJM/WECC), transmission voltage.
substation: estimate proximity for ${county||city}, ${state}.
fema: real zone(X/AE/A/V) for ${city} terrain.
elevation: realistic ft for ${city}.
epa: industrial history, Superfund proximity.
wetlands: regional patterns near ${city}.
fiber: real ISPs(AT&T/Spectrum/Zayo/Lumen/etc).
faa: nearest major airport and miles.
dot: actual rail lines in ${county||city}.
zoning: industrial/agricultural/mixed based on address.
water: municipal capacity for ${city}.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: 'You are a CBRE data center land qualification AI with deep knowledge of US power infrastructure, geography, environmental data, and real estate. Return ONLY valid compact JSON. No markdown. No backticks. No preamble. Keep each finding under 160 characters.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Anthropic API error ${response.status}: ${errBody.slice(0,300)}` }) };
    }

    const data = await response.json();
    if (data.error) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: data.error.message }) };
    }

    let raw = data.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();

    if (!raw.endsWith('}')) {
      const lastClose = raw.lastIndexOf('}');
      if (lastClose > 0) {
        raw = raw.substring(0, lastClose + 1);
        let opens = 0;
        for (const ch of raw) { if (ch==='['||ch==='{') opens++; else if (ch===']'||ch==='}') opens--; }
        while (opens > 1) { raw += '}]'; opens -= 2; }
        if (opens === 1) raw += '}';
      }
    }

    const parsed = JSON.parse(raw);
    return { statusCode: 200, headers, body: JSON.stringify(parsed) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Function error: ' + err.message }) };
  }
};
