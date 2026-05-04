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

  const prompt = `You are a CBRE data center land qualification AI. Analyze this property.

Property: ${addr}
County: ${county || 'infer from city/state'}
Acreage: ${acres || 'unknown'}
APN: ${apn || 'n/a'}

FIXED SCORING RUBRIC — use EXACTLY these point values, no exceptions:
- power_grid: max 20pts. 20=230kV+ confirmed, 15=115-230kV, 8=69-115kV, 3=distribution only, 0=unknown
- substation: max 15pts. 15=within 1mi, 10=1-3mi, 5=3-10mi, 2=10-20mi, 0=over 20mi
- fiber: max 10pts. 10=fiber on-site or <1mi multiple ISPs, 7=fiber within 5mi, 4=broadband only, 0=none
- faa: max 5pts. 5=over 15mi from airport, 3=5-15mi, 1=within 5mi no height issue, 0=within 5mi height restriction
- dot: max 0pts (informational only, always 0)
- fema: max 12pts. 12=Zone X (minimal hazard), 8=Zone B/C, 4=Zone A (100yr floodplain), 0=Zone AE/V
- elevation: max 5pts. 5=50-2500ft flat terrain, 3=under 50ft but workable, 1=very low under 10ft, 0=problematic
- epa: max 5pts. 5=clean area no facilities, 3=some facilities no violations, 1=minor issues, 0=Superfund or violations
- wetlands: max 8pts. 8=none within 1mi, 5=adjacent only, 2=partial on parcel, 0=significant wetlands
- acreage: max 15pts. 15=200+ acres, 10=50-199 acres, 5=15-49 acres, 2=5-14 acres, 0=under 5 or unknown
- zoning: max 10pts. 10=heavy industrial I-2/I-3, 7=light industrial I-1, 4=commercial/business park, 2=agricultural, 0=residential
- water: max 5pts. 5=confirmed high-volume municipal, 3=municipal limited capacity, 1=well or alternative, 0=none

GRADING (apply AFTER calculating score):
Total max points = 110
Score = round((sum_of_all_pts / 110) * 100) — this is the final score 0-100
Grade = A if score >= 75, B if score >= 60, C if score >= 45, D if score >= 30, F if below 30

IMPORTANT: A score of 78 = Grade A. A score of 65 = Grade B. Be fair and accurate.

Return ONLY valid JSON (no markdown, no backticks, no extra text):
{
  "geocoded_address": "${addr}",
  "city": "${city}",
  "state": "${state}",
  "county": "resolved county name",
  "zip": "${zip || ''}",
  "lat": estimated_latitude_as_number,
  "lng": estimated_longitude_as_number,
  "score": calculated_integer_0_to_100,
  "grade": "A or B or C or D or F",
  "verdict": "Likely Qualified if score>=60, Needs Further Review if score>=35, Does Not Qualify if below 35",
  "executive_summary": "4-5 sentences for CBRE leadership. State grade and score explicitly. Name 2 strongest assets and 2 critical risks specific to this location. Give clear recommendation.",
  "checks": [
    {"id":"power_grid","category":"Power Infrastructure","name":"Power Grid & Transmission","status":"pass or caution or flag or unknown","pts":0,"max":20,"finding":"2 sentences. Name actual utility provider for ${loc}. State ISO/RTO and transmission voltage tier.","detail":"3 sentences deeper analysis. Interconnection cost and timeline implications. Known grid constraints.","url":"https://www.ercot.com/gridinfo","url_label":"Grid data"},
    {"id":"substation","category":"Power Infrastructure","name":"Substation Proximity","status":"","pts":0,"max":15,"finding":"Name estimated substation distance and utility for ${county||city} County, ${state}.","detail":"Capacity estimate and interconnection cost implications.","url":"https://www.ferc.gov/industries-data/electric","url_label":"FERC data"},
    {"id":"fiber","category":"Connectivity","name":"Fiber & Broadband","status":"","pts":0,"max":10,"finding":"Name real ISPs serving ${city} (AT&T, Zayo, Lumen, Spectrum, etc). Fiber availability.","detail":"Dark fiber options, carrier-neutral connectivity feasibility.","url":"https://broadbandmap.fcc.gov","url_label":"FCC Map"},
    {"id":"faa","category":"Connectivity","name":"FAA Airspace","status":"","pts":0,"max":5,"finding":"Name nearest major airport to ${city}, ${state} and distance in miles. Height restriction risk.","detail":"FAA notification requirements. Building height limitations for data center construction.","url":"https://oeaaa.faa.gov/oeaaa/external/portal.jsp","url_label":"FAA tool"},
    {"id":"dot","category":"Connectivity","name":"DOT Rail & Freight","status":"unknown","pts":0,"max":0,"finding":"Name major rail lines and freight corridors in ${county||city} area, ${state}.","detail":"Vibration and easement concerns for adjacent sites.","url":"https://www.bts.gov/geospatial","url_label":"BTS map"},
    {"id":"fema","category":"Environmental & Hazards","name":"FEMA Flood Zone","status":"","pts":0,"max":12,"finding":"State the likely FEMA flood zone designation (X, AE, A, V, B/C) for ${city}, ${state} based on terrain and water proximity.","detail":"Flood insurance requirements, elevation certificate needs, mitigation measures required.","url":"https://msc.fema.gov","url_label":"FEMA Map"},
    {"id":"elevation","category":"Environmental & Hazards","name":"USGS Elevation & Terrain","status":"","pts":0,"max":5,"finding":"Estimate elevation in feet for ${city}, ${state}. Describe terrain type.","detail":"Drainage implications, grading costs, stormwater management considerations.","url":"https://apps.nationalmap.gov/epqs/","url_label":"USGS EPQS"},
    {"id":"epa","category":"Environmental & Hazards","name":"EPA Environmental Records","status":"","pts":0,"max":5,"finding":"Describe EPA environmental profile of ${county||city} area. Known industrial history or Superfund sites.","detail":"Phase I/II ESA recommendations. Specific environmental risks to investigate.","url":"https://echo.epa.gov","url_label":"EPA ECHO"},
    {"id":"wetlands","category":"Environmental & Hazards","name":"USFWS Wetlands","status":"","pts":0,"max":8,"finding":"Describe wetlands likelihood for ${city}, ${state} based on regional geography and water features.","detail":"Army Corps Section 404 permit requirements. Impact on buildable acreage.","url":"https://www.fws.gov/program/national-wetlands-inventory/wetlands-mapper","url_label":"NWI Mapper"},
    {"id":"acreage","category":"Site & Zoning","name":"Site Acreage & Scale","status":"","pts":0,"max":15,"finding":"${acres || 'Acreage not provided'}. State what deployment scale this supports (hyperscale, mid-scale, edge).","detail":"Campus expansion potential, phased development feasibility, minimum buildable area after setbacks.","url":"https://www.tdcaa.com/resources/county-websites/","url_label":"County CAD"},
    {"id":"zoning","category":"Site & Zoning","name":"Zoning & Land Use","status":"","pts":0,"max":10,"finding":"Estimate likely zoning for ${street}, ${city} based on address type and regional context.","detail":"Rezoning timeline and feasibility if needed. Special use permit requirements for data centers.","url":"https://www.planning.org/knowledgebase/gis/","url_label":"Local GIS"},
    {"id":"water","category":"Site & Zoning","name":"Municipal Water","status":"","pts":0,"max":5,"finding":"Describe municipal water infrastructure in ${city}, ${state}. Data centers need 1-5M+ gallons/day.","detail":"Water stress index for region. Cooling system implications. Recycled water availability.","url":"https://www.epa.gov/waterdata/waters-geoviewer","url_label":"EPA Water"}
  ]
}

Be specific. Name real utilities, real airports, real rail lines. Calculate score and grade accurately per the rubric.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 5000,
        system: 'You are a CBRE data center land qualification AI. Return ONLY valid compact JSON. No markdown. No backticks. No preamble. Be precise with scoring rubric and grade calculation.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!r.ok) {
      const e = await r.text().catch(() => '');
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Anthropic API error ${r.status}: ${e.slice(0, 300)}` }) };
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
        for (const ch of raw) { if (ch === '[' || ch === '{') o++; else if (ch === ']' || ch === '}') o--; }
        while (o > 1) { raw += '}]'; o -= 2; }
        if (o === 1) raw += '}';
      }
    }

    const parsed = JSON.parse(raw);

    // Normalize coordinates — handle both {lat,lng} object and flat lat/lng fields
    if (!parsed.coordinates || typeof parsed.coordinates !== 'object') {
      parsed.coordinates = {
        lat: parseFloat(parsed.lat || parsed.coordinates?.lat || 0),
        lng: parseFloat(parsed.lng || parsed.coordinates?.lng || 0)
      };
    }
    // Clean up flat fields
    delete parsed.lat;
    delete parsed.lng;

    // Recalculate score and grade server-side to ensure consistency
    const checks = parsed.checks || [];
    const totalPts = checks.reduce((s, c) => s + (parseInt(c.pts) || 0), 0);
    const maxPts = checks.reduce((s, c) => s + (parseInt(c.max) || 0), 0);
    const score = maxPts > 0 ? Math.min(100, Math.round((totalPts / maxPts) * 100)) : parsed.score || 0;
    const grade = score >= 75 ? 'A' : score >= 60 ? 'B' : score >= 45 ? 'C' : score >= 30 ? 'D' : 'F';
    const verdict = score >= 60 ? 'Likely Qualified' : score >= 35 ? 'Needs Further Review' : 'Does Not Qualify';

    parsed.score = score;
    parsed.grade = grade;
    parsed.verdict = verdict;
    parsed.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    parsed.analyzedAt = new Date().toISOString();
    parsed.submittedBy = submittedBy || 'CBRE Team';
    parsed.address_input = { street, city, state, county, zip, acres, apn };

    return { statusCode: 200, headers, body: JSON.stringify(parsed) };

  } catch (err) {
    console.error('Handler error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Function error: ' + err.message }) };
  }
};
