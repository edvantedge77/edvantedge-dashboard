// Netlify Function: dialpad-proxy.js
// Server-side proxy for Dialpad API calls (bypasses CORS)

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const DIALPAD_API_KEY = process.env.DIALPAD_API_KEY;
  if (!DIALPAD_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Dialpad API key not configured' }) };
  }

  try {
    const params = event.queryStringParameters || {};
    const action = params.action;

    let url, response, data;

    if (action === 'find_call') {
      // Find call by phone number using Dialpad's search endpoint
      const { phone, minutes_ago = 60 } = params;
      if (!phone) return { statusCode: 400, headers, body: JSON.stringify({ error: 'phone required' }) };

      const cleanPhone = phone.replace(/\D/g, '');
      const cutoff = Math.floor(Date.now() / 1000) - (parseInt(minutes_ago) * 60);

      // Try searching by phone number directly
      url = `https://dialpad.com/api/v2/call?apikey=${DIALPAD_API_KEY}&external_number=${encodeURIComponent('+' + cleanPhone)}&limit=10`;
      response = await fetch(url);
      data = await response.json();

      if (!response.ok) {
        // Fallback: try without + prefix
        url = `https://dialpad.com/api/v2/call?apikey=${DIALPAD_API_KEY}&external_number=${encodeURIComponent(cleanPhone)}&limit=10`;
        response = await fetch(url);
        data = await response.json();

        if (!response.ok) {
          return { statusCode: response.status, headers, body: JSON.stringify({ error: data, tried_url: url }) };
        }
      }

      // Filter to recent calls within the time window
      const calls = (data.items || []).filter(call => {
        const callStarted = call.date_started || call.date_connected || 0;
        return callStarted >= cutoff;
      });

      return { statusCode: 200, headers, body: JSON.stringify({ calls, total: data.items?.length || 0, raw: data }) };

    } else if (action === 'get_recording') {
      const { call_id } = params;
      if (!call_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'call_id required' }) };

      url = `https://dialpad.com/api/v2/call/${call_id}?apikey=${DIALPAD_API_KEY}`;
      response = await fetch(url);
      data = await response.json();

      return { statusCode: response.status, headers, body: JSON.stringify(data) };

    } else if (action === 'get_transcript') {
      const { call_id } = params;
      if (!call_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'call_id required' }) };

      url = `https://dialpad.com/api/v2/transcript/${call_id}?apikey=${DIALPAD_API_KEY}`;
      response = await fetch(url);
      data = await response.json();

      return { statusCode: response.status, headers, body: JSON.stringify(data) };

    } else if (action === 'download_recording') {
      const { recording_url } = params;
      if (!recording_url) return { statusCode: 400, headers, body: JSON.stringify({ error: 'recording_url required' }) };

      // Download recording and return as base64
      response = await fetch(recording_url, {
        headers: { 'Authorization': `Bearer ${DIALPAD_API_KEY}` }
      });

      if (!response.ok) {
        return { statusCode: response.status, headers, body: JSON.stringify({ error: 'Failed to download recording' }) };
      }

      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const contentType = response.headers.get('content-type') || 'audio/mpeg';

      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, contentType, size: buffer.byteLength })
      };

    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action. Use: find_call, get_recording, get_transcript, download_recording' }) };
    }

  } catch (err) {
    console.error('Dialpad proxy error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
