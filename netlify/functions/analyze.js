exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured.' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

  const { street, city, state, county, zip, acres, apn, submittedBy } = body;
  if (!street || !city || !state) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Street, city, and state are required.' }) };

  const addr = [street, city, state, zip].filter(Boolean).join(', ');
  const loc = [county || city, state].filter(Boolean).join(', ');

  const prompt = `CBRE data center land analysis. Return ONLY compact JSON, no markdown.

Property: ${addr} | County: ${county||'infer'} | Acres: ${acres||'unknown'}

SCORING (pts/max): power_grid(0-20), substation(0-15), fiber(0-10), faa(0-5), dot(0-0), fema(0-12), elevation(0-5), epa(0-5), wetlands(0-8), acreage(0-15), zoning(0-10), water(0-5). Max=110.
Score=round(sum/110*100). Grade: A>=75, B>=60, C>=45, D>=30, F<30.

Return this JSON filled in:
{"geocoded_address":"${addr}","city":"${city}","state":"${state}","county":"","lat":0.0,"lng":0.0,"score":0,"grade":"","verdict":"","executive_summary":"","checks":[
{"id":"power_grid","category":"Power Infrastructure","name":"Power Grid & Transmission","status":"","pts":0,"max":20,"finding":"","url":"https://www.ercot.com/gridinfo","url_label":"Grid data"},
{"id":"substation","category":"Power Infrastructure","name":"Substation Proximity","status":"","pts":0,"max":15,"finding":"","url":"https://www.ferc.gov","url_label":"FERC"},
{"id":"fiber","category":"Connectivity","name":"Fiber & Broadband","status":"","pts":0,"max":10,"finding":"","url":"https://broadbandmap.fcc.gov","url_label":"FCC Map"},
{"id":"faa","category":"Connectivity","name":"FAA Airspace","status":"","pts":0,"max":5,"finding":"","url":"https://oeaaa.faa.gov","url_label":"FAA"},
{"id":"dot","category":"Connectivity","name":"DOT Rail & Freight","status":"unknown","pts":0,"max":0,"finding":"","url":"https://www.bts.gov","url_label":"BTS"},
{"id":"fema","category":"Environmental & Hazards","name":"FEMA Flood Zone","status":"","pts":0,"max":12,"finding":"","url":"https://msc.fema.gov","url_label":"FEMA"},
{"id":"elevation","category":"Environmental & Hazards","name":"USGS Elevation","status":"","pts":0,"max":5,"finding":"","url":"https://apps.nationalmap.gov/epqs/","url_label":"USGS"},
{"id":"epa","category":"Environmental & Hazards","name":"EPA Environmental","status":"","pts":0,"max":5,"finding":"","url":"https://echo.epa.gov","url_label":"EPA ECHO"},
{"id":"wetlands","category":"Environmental & Hazards","name":"USFWS Wetlands","status":"","pts":0,"max":8,"finding":"","url":"https://www.fws.gov/program/national-wetlands-inventory","url_label":"NWI"},
{"id":"acreage","category":"Site & Zoning","name":"Site Acreage","status":"","pts":0,"max":15,"finding":"","url":"https://www.tdcaa.com/resources/county-websites/","url_label":"County CAD"},
{"id":"zoning","category":"Site & Zoning","name":"Zoning & Land Use","status":"","pts":0,"max":10,"finding":"","url":"https://www.planning.org","url_label":"Local GIS"},
{"id":"water","category":"Site & Zoning","name":"Municipal Water","status":"","pts":0,"max":5,"finding":"","url":"https://www.epa.gov/waterdata","url_label":"EPA Water"}
]}

Rules: status=pass|caution|flag|unknown. finding=1 sentence max 120 chars naming real utilities/airports. executive_summary=3 sentences. lat/lng=real coordinates for ${city} ${state}. score/grade per rubric.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: 'Return ONLY valid compact JSON. No markdown. No backticks. No explanation. Be concise.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!r.ok) {
      const e = await r.text().catch(() => '');
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Anthropic API error ${r.status}: ${e.slice(0, 200)}` }) };
    }

    const data = await r.json();
    if (data.error) return { statusCode: 502, headers, body: JSON.stringify({ error: data.error.message }) };

    let raw = data.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();

    // Repair truncated JSON
    if (!raw.endsWith('}')) {
      const lc = raw.lastIndexOf('}');
      if (lc > 0) {
        raw = raw.substring(0, lc + 1);
        let o = 0;
        for (const ch of raw) { if (ch==='['||ch==='{') o++; else if (ch===']'||ch==='}') o--; }
        while (o > 1) { raw += '}]'; o -= 2; }
        if (o === 1) raw += '}';
      }
    }

    const parsed = JSON.parse(raw);

    // Normalize coordinates
    parsed.coordinates = {
      lat: parseFloat(parsed.lat || 0),
      lng: parseFloat(parsed.lng || 0)
    };
    delete parsed.lat; delete parsed.lng;

    // Recalculate score and grade server-side
    const checks = parsed.checks || [];
    const totalPts = checks.reduce((s, c) => s + (parseInt(c.pts) || 0), 0);
    const maxPts = checks.reduce((s, c) => s + (parseInt(c.max) || 0), 0);
    const score = maxPts > 0 ? Math.min(100, Math.round((totalPts / maxPts) * 100)) : parsed.score || 0;
    parsed.score = score;
    parsed.grade = score >= 75 ? 'A' : score >= 60 ? 'B' : score >= 45 ? 'C' : score >= 30 ? 'D' : 'F';
    parsed.verdict = score >= 60 ? 'Likely Qualified' : score >= 35 ? 'Needs Further Review' : 'Does Not Qualify';
    parsed.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    parsed.analyzedAt = new Date().toISOString();
    parsed.submittedBy = submittedBy || 'CBRE Team';
    parsed.address_input = { street, city, state, county, zip, acres, apn };

    return { statusCode: 200, headers, body: JSON.stringify(parsed) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Function error: ' + err.message }) };
  }
};
