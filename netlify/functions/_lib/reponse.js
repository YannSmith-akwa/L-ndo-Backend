const ENTETES_BASE = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': process.env.ORIGINE_AUTORISEE || '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(statusCode, corps) {
  return { statusCode, headers: ENTETES_BASE, body: JSON.stringify(corps) };
}

function erreur(statusCode, message) {
  return json(statusCode, { message });
}

// Répond immédiatement aux requêtes préliminaires CORS (OPTIONS) —
// à appeler en tout début de chaque handler.
function reponsePreliminaireCORS(event) {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  return null;
}

module.exports = { json, erreur, reponsePreliminaireCORS };
