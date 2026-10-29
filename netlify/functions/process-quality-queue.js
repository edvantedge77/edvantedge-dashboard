// process-quality-queue.js — Netlify Scheduled Function
// Runs every 5 minutes via netlify.toml [functions] schedule.
// Picks up quality_results rows that are stuck in fetching_transcript / pending_transcript
// (with a dialpad_call_id set), fetches the transcript, scores the call, and writes
// the final result back to Supabase — all server-side, independent of any browser tab.
//
// Schedule: */5 * * * *  (every 5 minutes, defined in netlify.toml)

const SUPABASE_URL  = process.env.SUPABASE_URL;
// Use service key if available (bypasses RLS); fallback to anon key (RLS is open on quality_results)
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const DIALPAD_KEY   = process.env.DIALPAD_API_KEY;
const GROQ_KEY      = process.env.GROQ_API_KEY_TRANSCRIPT;
const NETLIFY_URL   = process.env.URL || 'https://edvantedgecrm.netlify.app';

const MAX_RECORDS_PER_RUN = 10;   // process at most 10 per tick to stay within function timeout
const TRANSCRIPT_RETRY_AFTER_MIN = 2;  // don't retry within 2 min of last attempt

// ── Supabase REST helpers ──────────────────────────────────────────────────────
async function sbSelect(table, filter){
  const url = `${SUPABASE_URL}/rest/v1/${table}?${filter}&limit=${MAX_RECORDS_PER_RUN}`;
  const r = await fetch(url, { headers: sbHeaders() });
  if(!r.ok) throw new Error(`Supabase SELECT ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbUpdate(table, id, patch){
  const url = `${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  });
  if(!r.ok) throw new Error(`Supabase PATCH ${table}/${id}: ${r.status} ${await r.text()}`);
}
async function sbSelectOne(table, filter){
  const url = `${SUPABASE_URL}/rest/v1/${table}?${filter}&limit=1`;
  const r = await fetch(url, { headers: sbHeaders() });
  if(!r.ok) return null;
  const rows = await r.json();
  return rows?.[0] || null;
}
function sbHeaders(){
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Accept': 'application/json',
  };
}

// ── Dialpad transcript fetch ───────────────────────────────────────────────────
async function fetchTranscript(callId){
  // Use the same dialpad-proxy flow already in production
  // (re-implement inline to avoid Netlify function-to-function HTTP call latency issues)
  const url = `https://dialpad.com/api/v2/call/${callId}`;
  const r = await fetch(url, {
    headers: { 'Authorization': `Bearer ${DIALPAD_KEY}`, 'Accept': 'application/json' }
  });
  if(!r.ok){
    const txt = await r.text();
    throw new Error(`Dialpad ${r.status}: ${txt.slice(0,200)}`);
  }
  const data = await r.json();
  // Transcript may be in data.transcription.transcript or data.transcript
  const tx = data?.transcription?.transcript || data?.transcript || '';
  return { transcript: tx, raw: data };
}

// ── AI scoring ─────────────────────────────────────────────────────────────────
async function scoreTranscript(transcript, promptConfig, callMeta){
  const r = await fetch(`${NETLIFY_URL}/.netlify/functions/score-transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, prompt_config: promptConfig, call_metadata: callMeta })
  });
  if(!r.ok){
    const txt = await r.text();
    throw new Error(`score-transcript ${r.status}: ${txt.slice(0,200)}`);
  }
  return r.json();
}

// ── Main handler ───────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const isScheduled = event?.['scheduled'] === true || event?.httpMethod === undefined;
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  if(!isScheduled && event.httpMethod === 'OPTIONS')
    return { statusCode: 204, headers: cors, body: '' };

  if(!SUPABASE_URL || !SUPABASE_KEY){
    console.error('[queue] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Supabase env vars missing' }) };
  }

  const cutoff = new Date(Date.now() - TRANSCRIPT_RETRY_AFTER_MIN * 60 * 1000).toISOString();

  // Find records that need transcript + scoring:
  //   processing_status IN (fetching_transcript, pending_transcript)
  //   AND dialpad_call_id is not null
  //   AND (last updated more than 2 min ago OR never had a fetch attempt)
  //   Exclude records already being processed (scored, scoring)
  let rows;
  try {
    rows = await sbSelect(
      'quality_results',
      `select=id,dialpad_call_id,client,region,agent_name,parent_name,phone,disposed_at,processing_status,transcript,additional_call_ids` +
      `&processing_status=in.(fetching_transcript,pending_transcript)` +
      `&dialpad_call_id=not.is.null` +
      `&order=disposed_at.asc`
    );
  } catch(e){
    console.error('[queue] Failed to fetch pending records:', e.message);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }

  if(!rows || rows.length === 0){
    console.log('[queue] No pending records to process.');
    return { statusCode: 200, headers: cors, body: JSON.stringify({ processed: 0 }) };
  }

  console.log(`[queue] Processing ${rows.length} pending quality record(s)…`);
  const results = [];

  for(const row of rows){
    const { id, dialpad_call_id, client, region, agent_name, parent_name, phone, disposed_at } = row;
    console.log(`[queue] → ${id} | ${phone} | ${client} | callId=${dialpad_call_id}`);

    try {
      // 1. Mark as fetching (idempotent — may already be this status)
      await sbUpdate('quality_results', id, { processing_status: 'fetching_transcript', last_queue_attempt: new Date().toISOString() });

      // 2. Fetch transcript from Dialpad
      let transcript = '';
      try {
        const txResult = await fetchTranscript(dialpad_call_id);
        transcript = txResult.transcript || '';
      } catch(txErr){
        console.warn(`[queue] Transcript fetch failed for ${id}:`, txErr.message);
        await sbUpdate('quality_results', id, {
          processing_status: 'transcript_error',
          quality_status: 'Manual Review',
          ai_summary: `[Auto-queue] Transcript fetch failed: ${txErr.message}. Will retry next cycle.`,
          last_queue_attempt: new Date().toISOString()
        });
        results.push({ id, status: 'transcript_error', error: txErr.message });
        continue;
      }

      if(!transcript){
        console.warn(`[queue] Empty transcript for ${id} — Dialpad may still be processing`);
        await sbUpdate('quality_results', id, {
          processing_status: 'fetching_transcript',
          ai_summary: '[Auto-queue] Transcript not yet available in Dialpad — will retry next cycle.',
          last_queue_attempt: new Date().toISOString()
        });
        results.push({ id, status: 'empty_transcript' });
        continue;
      }

      // 3. Store transcript, move to scoring
      await sbUpdate('quality_results', id, { transcript, processing_status: 'scoring' });

      // 4. Load prompt config from quality_prompts table
      let promptConfig = { client, parameters: [], overall_instructions: '' };
      try {
        const promptRow = await sbSelectOne('quality_prompts', `client=eq.${encodeURIComponent(client)}&is_active=eq.true`);
        if(promptRow?.parameters && Array.isArray(promptRow.parameters)){
          promptConfig = {
            client,
            parameters: promptRow.parameters,
            overall_instructions: promptRow.overall_instructions || promptRow.prompt_text || ''
          };
        } else if(promptRow?.prompt_text){
          promptConfig = { client, parameters: [], overall_instructions: promptRow.prompt_text };
        }
      } catch(pe){ console.warn('[queue] Could not load prompt config:', pe.message); }

      // 5. Score via Groq
      let scored;
      try {
        scored = await scoreTranscript(transcript, promptConfig, {
          agent_name, parent_name, region,
          call_date: disposed_at ? new Date(disposed_at).toLocaleDateString('en-IN') : ''
        });
      } catch(scoreErr){
        console.warn(`[queue] Scoring failed for ${id}:`, scoreErr.message);
        await sbUpdate('quality_results', id, {
          processing_status: 'scoring_error',
          quality_status: 'Manual Review',
          ai_summary: `[Auto-queue] Scoring failed: ${scoreErr.message}`,
          last_queue_attempt: new Date().toISOString()
        });
        results.push({ id, status: 'scoring_error', error: scoreErr.message });
        continue;
      }

      // 6. Write final result back to Supabase
      const statusMap = { VALID:'Valid', INVALID:'Invalid', MANUAL_REVIEW:'Manual Review' };
      const finalStatus = statusMap[scored.overall_status] || 'Manual Review';

      await sbUpdate('quality_results', id, {
        quality_status: finalStatus,
        score: scored.overall_score || scored.weighted_score || 0,
        weighted_score: scored.weighted_score || scored.overall_score || 0,
        ai_summary: scored.summary || '',
        parameters_detail: JSON.stringify({
          parameters: scored.parameters || [],
          key_issues: scored.key_issues || [],
          strengths: scored.strengths || [],
          mandatory_fail: scored.mandatory_fail || false
        }),
        processing_status: 'scored',
        scored_at: new Date().toISOString(),
        last_queue_attempt: new Date().toISOString()
      });

      console.log(`[queue] ✅ ${id} scored → ${finalStatus} (${scored.weighted_score || scored.overall_score})`);
      results.push({ id, status: 'scored', quality_status: finalStatus, score: scored.weighted_score || scored.overall_score });

    } catch(e){
      console.error(`[queue] Unexpected error for ${id}:`, e.message);
      try {
        await sbUpdate('quality_results', id, {
          processing_status: 'failed',
          ai_summary: '[Auto-queue] Unexpected error: ' + e.message,
          last_queue_attempt: new Date().toISOString()
        });
      } catch(_){}
      results.push({ id, status: 'failed', error: e.message });
    }
  }

  console.log('[queue] Done.', JSON.stringify(results));
  return {
    statusCode: 200,
    headers: cors,
    body: JSON.stringify({ processed: results.length, results })
  };
};
