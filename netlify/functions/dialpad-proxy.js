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
    // Support POST body to avoid WAF blocking sensitive data in query string
    let bodyParams = {};
    if (event.body) {
      try { bodyParams = JSON.parse(event.body); } catch(e) {}
    }
    const params = { ...( event.queryStringParameters || {}), ...bodyParams };
    const action = params.action;

    let url, response, data;

    if (action === 'find_call') {
      // Find call by phone number using Dialpad's search endpoint
      const { phone, minutes_ago = 60 } = params;
      if (!phone) return { statusCode: 400, headers, body: JSON.stringify({ error: 'phone required' }) };

      const cleanPhone = phone.replace(/\D/g, '');
      const cutoff = Math.floor(Date.now() / 1000) - (parseInt(minutes_ago) * 60);

      // Use Authorization header instead of query string (avoids WAF blocking)
      const dialpadHeaders = { 'Authorization': `Bearer ${DIALPAD_API_KEY}` };
      const now = Math.floor(Date.now() / 1000);
      const dateStart = new Date((now - parseInt(minutes_ago) * 60) * 1000).toISOString().split('T')[0];

      // Try searching via contact endpoint first
      url = `https://dialpad.com/api/v2/contacts?phone=${encodeURIComponent('+' + cleanPhone)}`;
      response = await fetch(url, { headers: dialpadHeaders });
      const contactData = await response.json();

      // Try call search with date range
      const url2 = `https://dialpad.com/api/v2/call?date_start=${dateStart}&limit=50`;
      const response2 = await fetch(url2, { headers: dialpadHeaders });
      const data2 = await response2.json();

      if (response2.ok) {
        const calls = (data2.items || []).filter(call => {
          const callPhone = (call.contact?.phone || call.external_number || '').replace(/\D/g, '');
          return callPhone.endsWith(cleanPhone.slice(-10));
        });
        return { statusCode: 200, headers, body: JSON.stringify({ calls, total: data2.items?.length || 0, contact: contactData }) };
      }

      // Last resort: return contact info if found, let CRM handle it
      return {
        statusCode: response2.status,
        headers,
        body: JSON.stringify({
          error: data2,
          contact: contactData,
          note: 'Call listing requires admin API key. Use get_recording with a specific call_id instead.',
          tried: [url, url2]
        })
      };

    } else if (action === 'get_recording') {
      const { call_id } = params;
      if (!call_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'call_id required' }) };

      url = `https://dialpad.com/api/v2/call/${call_id}`;
      response = await fetch(url, { headers: { 'Authorization': `Bearer ${DIALPAD_API_KEY}` } });
      data = await response.json();

      return { statusCode: response.status, headers, body: JSON.stringify(data) };

    } else if (action === 'get_transcript') {
      const { call_id } = params;
      if (!call_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'call_id required' }) };

      url = `https://dialpad.com/api/v2/transcript/${call_id}`;
      response = await fetch(url, { headers: { 'Authorization': `Bearer ${DIALPAD_API_KEY}` } });
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
