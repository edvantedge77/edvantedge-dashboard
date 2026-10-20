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
    const url = `https://dialpad.com/api/v2/transcript/${encodeURIComponent(call_id)}`;
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

    // Extract transcript text — Dialpad returns an array of lines or a single string
    let transcript = '';
    if (typeof data.transcript === 'string') {
      transcript = data.transcript;
    } else if (Array.isArray(data.transcript)) {
      // Format: [{speaker, content, ...}]
      transcript = data.transcript
        .map(seg => {
          const speaker = seg.speaker_name || seg.speaker || 'Speaker';
          const content = seg.content || seg.text || '';
          return `${speaker}: ${content}`;
        })
        .join('\n');
    } else if (Array.isArray(data.lines)) {
      transcript = data.lines
        .map(l => `${l.speaker || 'Speaker'}: ${l.content || l.text || ''}`)
        .join('\n');
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
