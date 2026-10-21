// dialpad-proxy.js — Netlify Function
// Fetches transcript from Dialpad API using a Call ID provided by the agent.
// Only supports action: 'get_transcript'

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { action, call_id } = body;

  if (action !== 'get_transcript') {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
  }

  if (!call_id) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'call_id is required' }) };
  }

  const apiKey = process.env.DIALPAD_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'DIALPAD_API_KEY env var not set' }) };
  }

  try {
    const url = `https://dialpad.com/api/v2/transcripts/${encodeURIComponent(call_id)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: cors,
        body: JSON.stringify({ error: `Dialpad API error ${res.status}`, details: data }),
      };
    }

    // Extract transcript text — handle all Dialpad response formats
    let transcript = '';
    const parseSegments = (arr) =>
      arr
        .filter(seg => seg.type === 'transcript' || seg.content)
        .map(seg => {
          const speaker = seg.name || seg.speaker_name || seg.speaker || 'Speaker';
          const content = seg.content || seg.text || '';
          return `${speaker}: ${content}`;
        })
        .join('\n');

    if (Array.isArray(data)) {
      // Root-level array of transcript segments
      transcript = parseSegments(data);
    } else if (typeof data.transcript === 'string') {
      transcript = data.transcript;
    } else if (Array.isArray(data.transcript)) {
      transcript = parseSegments(data.transcript);
    } else if (Array.isArray(data.items)) {
      transcript = parseSegments(data.items);
    } else if (Array.isArray(data.lines)) {
      transcript = parseSegments(data.lines);
    } else if (data.content) {
      transcript = data.content;
    }

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, raw: data }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: 'Fetch failed: ' + err.message }),
    };
  }
};
