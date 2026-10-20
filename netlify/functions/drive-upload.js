// Netlify Function: drive-upload.js
// Uploads recording to Google Drive and handles 60-day cleanup

const { google } = require('googleapis');

function getDriveClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth });
}

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { action } = body;

    const drive = getDriveClient();

    if (action === 'upload') {
      const { base64_audio, filename, folder_id, content_type = 'audio/mpeg' } = body;
      if (!base64_audio || !filename || !folder_id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'base64_audio, filename, folder_id required' }) };
      }

      const buffer = Buffer.from(base64_audio, 'base64');
      const { Readable } = require('stream');
      const stream = Readable.from(buffer);

      const res = await drive.files.create({
        requestBody: {
          name: filename,
          parents: [folder_id]
        },
        media: {
          mimeType: content_type,
          body: stream
        },
        fields: 'id, name, webViewLink, webContentLink'
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          file_id: res.data.id,
          file_name: res.data.name,
          view_url: res.data.webViewLink,
          download_url: res.data.webContentLink
        })
      };

    } else if (action === 'delete') {
      const { file_id } = body;
      if (!file_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'file_id required' }) };

      await drive.files.delete({ fileId: file_id });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, deleted: file_id }) };

    } else if (action === 'cleanup_expired') {
      // Called by scheduled job - deletes Drive files for records older than 60 days
      // Returns list of file_ids deleted so caller can update Supabase
      const { expired_records } = body; // Array of { quality_result_id, drive_file_id }
      if (!expired_records || !Array.isArray(expired_records)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'expired_records array required' }) };
      }

      const results = [];
      for (const record of expired_records) {
        try {
          if (record.drive_file_id) {
            await drive.files.delete({ fileId: record.drive_file_id });
          }
          results.push({ id: record.quality_result_id, success: true });
        } catch (err) {
          results.push({ id: record.quality_result_id, success: false, error: err.message });
        }
      }

      return { statusCode: 200, headers, body: JSON.stringify({ results }) };

    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action. Use: upload, delete, cleanup_expired' }) };
    }

  } catch (err) {
    console.error('Drive upload error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
