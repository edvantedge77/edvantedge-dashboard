// Netlify Function: score-transcript.js
// Scores call transcript using Groq AI with client-specific prompts

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY_TRANSCRIPT;
  if (!GROQ_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Groq API key not configured' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { transcript, prompt_config, call_metadata } = body;

    if (!transcript) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'transcript required' }) };
    }
    if (!prompt_config) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'prompt_config required' }) };
    }

    const { client, parameters = [], overall_instructions = '' } = prompt_config;

    let parameterInstructions = '';
    if (parameters.length > 0) {
      parameterInstructions = `\n\nEVALUATION PARAMETERS:\n`;
      parameters.forEach((p, i) => {
        parameterInstructions += `\n${i + 1}. ${p.name} (Weight: ${p.weight}%${p.mandatory ? ', MANDATORY' : ''})\n`;
        if (p.description) parameterInstructions += `   Description: ${p.description}\n`;
        if (p.scoring_rule) parameterInstructions += `   Scoring Rule: ${p.scoring_rule}\n`;
      });
      const totalWeight = parameters.reduce((sum, p) => sum + (parseFloat(p.weight) || 0), 0);
      parameterInstructions += `\nTotal weight: ${totalWeight}%`;
    }

    const fullPrompt = `You are a quality evaluator for ${client || 'an education company'} demo scheduling calls.

${overall_instructions}${parameterInstructions}

CALL METADATA:
- Agent: ${call_metadata?.agent_name || 'Unknown'}
- Parent/Lead: ${call_metadata?.parent_name || 'Unknown'}
- Region: ${call_metadata?.region || 'Unknown'}
- Call Date: ${call_metadata?.call_date || new Date().toLocaleDateString('en-IN')}

You must evaluate the transcript and return a JSON response with this exact structure:
{
  "overall_status": "VALID" | "INVALID" | "MANUAL_REVIEW",
  "overall_score": <number 0-100>,
  "mandatory_fail": <true if any mandatory parameter failed, false otherwise>,
  "parameters": [
    {
      "name": "<parameter name>",
      "score": <number 0-100>,
      "weight": <weight percentage>,
      "mandatory": <true/false>,
      "status": "PASS" | "FAIL" | "PARTIAL",
      "evidence": "<exact quote from transcript supporting this score>",
      "reasoning": "<brief explanation>"
    }
  ],
  "weighted_score": <calculated weighted score 0-100>,
  "summary": "<2-3 sentence overall summary>",
  "key_issues": ["<issue 1>", "<issue 2>"],
  "strengths": ["<strength 1>", "<strength 2>"]
}

Rules:
- overall_status is INVALID if any MANDATORY parameter fails
- overall_status is VALID if weighted_score >= 70 and no mandatory failures
- overall_status is MANUAL_REVIEW if weighted_score is 50-69 or there is ambiguity
- Always provide evidence quotes from the actual transcript
- Be objective and consistent
- Return ONLY valid JSON, no markdown, no explanation outside the JSON

TRANSCRIPT TO EVALUATE:
${transcript}`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: fullPrompt }],
        temperature: 0.2,
        max_tokens: 2000
      })
    });

    const groqData = await groqRes.json();

    if (!groqRes.ok) {
      return {
        statusCode: groqRes.status,
        headers,
        body: JSON.stringify({ error: 'Groq API error', details: groqData })
      };
    }

    const content = groqData.choices?.[0]?.message?.content || '';

    let scored;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      scored = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    } catch (parseErr) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          overall_status: 'MANUAL_REVIEW',
          error: 'Could not parse AI response',
          raw_response: content.slice(0, 500)
        })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(scored)
    };

  } catch (err) {
    console.error('Score transcript error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
